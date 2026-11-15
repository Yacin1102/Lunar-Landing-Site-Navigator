"""Tests for the error bound (skyline_err_deg) and the independent line-of-sight check.

What is established here (spec sections 7 and 13):

* For every wedge, ``skyline +/- err`` contains the skyline at every single
  azimuth of the wedge, measured independently by line of sight, both on
  the map as it is and on maps perturbed anywhere within the error model.
* So a point of the Sun's disc classified "lit" is really reached by a line
  of sight, and one classified "blocked" is really stopped.
* The error grows with the map's height error and horizontal error.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from lunar_engine import lineofsight as los
from lunar_engine.elevation import ElevationSource, HeightGrid, to_xy
from lunar_engine.geometry import R_MOON_M, enu_frame, lat_lon_radius
from lunar_engine.skyline import compute_skyline
from lunar_engine.synthetic import Cone, RingWall, SyntheticElevation
from lunar_engine.uncertainty import FRAME_ANGLE_DEG, _ShiftedSource, skyline_with_error

SITE = (-89.95, 30.0)
SUN_RADIUS_DEG = 0.2666


def destination(lat, lon, distance_m, azimuth_deg):
    east, north, up = enu_frame(lat, lon)
    a, t = math.radians(azimuth_deg), distance_m / R_MOON_M
    lat2, lon2, _ = lat_lon_radius(math.cos(t) * up + math.sin(t) * (math.cos(a) * north + math.sin(a) * east))
    return float(lat2), float(lon2)


def cones(seed=1, count=25):
    rng = np.random.default_rng(seed)
    shapes = []
    for _ in range(count):
        lat, lon = destination(*SITE, rng.uniform(1_000.0, 6_000.0), rng.uniform(0.0, 360.0))
        shapes.append(Cone(lat, lon, rng.uniform(200.0, 1_200.0), rng.uniform(30.0, 400.0)))
    return shapes


@pytest.fixture(scope="module")
def cone_world():
    return SyntheticElevation(cones(), grids=[(40.0, 8_000.0)], center=SITE,
                              beyond_maps_height_m=0.0, error_m=0.5)


@pytest.fixture(scope="module")
def cone_bounds(cone_world):
    return skyline_with_error(cone_world, *SITE, mast_m=2.0, az_step_deg=0.1)


def random_azimuths(rng, n_wedges, step, count):
    wedge = rng.integers(0, n_wedges, count)
    return wedge, (wedge - 0.5 + rng.uniform(0.0, 1.0, count)) * step


# ---- The line-of-sight module itself -------------------------------------------------

def test_line_of_sight_on_a_smooth_sphere():
    """Hand calculation: from 2 m up the horizon is 0.0869 deg below level."""
    world = SyntheticElevation([], grids=[(40.0, 12_000.0)], center=SITE, beyond_maps_height_m=0.0)
    dip = -math.degrees(math.acos(R_MOON_M / (R_MOON_M + 2.0)))
    profile = los.azimuth_profile(world, *SITE, 2.0, [0.0, 90.0, 200.0])
    assert profile == pytest.approx([dip] * 3, abs=1e-4)
    blocked = los.ray_blocked(world, *SITE, 2.0, [10.0, 10.0, 250.0], [dip - 0.01, dip + 0.01, -5.0])
    assert list(blocked) == [True, False, True]


def test_line_of_sight_reports_unknown_when_unmapped_terrain_could_block():
    world = SyntheticElevation([], grids=[(40.0, 4_000.0)], center=SITE)      # beyond: up to 11 km
    assert los.ray_blocked(world, *SITE, 2.0, [0.0], [2.0])[0] is None
    assert los.ray_blocked(world, *SITE, 2.0, [0.0], [80.0])[0] is False


# ---- The interval contains every azimuth's skyline ---------------------------------------

def test_interval_contains_the_skyline_at_every_azimuth_measured_independently(cone_bounds, cone_world):
    rng = np.random.default_rng(3)
    wedge, az = random_azimuths(rng, 3600, 0.1, 1_200)
    profile = los.azimuth_profile(cone_world, *SITE, 2.0, az)
    low = cone_bounds.skyline_deg[wedge] - cone_bounds.skyline_err_deg[wedge]
    high = cone_bounds.skyline_deg[wedge] + cone_bounds.skyline_err_deg[wedge]
    print(f"\n1200 azimuths: smallest margin to the bottom {np.min(profile - low):.4f} deg, "
          f"to the top {np.min(high - profile):.4f} deg; error mean "
          f"{cone_bounds.skyline_err_deg.mean():.4f}, max {cone_bounds.skyline_err_deg.max():.4f} deg")
    assert np.all(profile >= low) and np.all(profile <= high)


@pytest.mark.parametrize("pattern", ["random signs", "all up", "all down", "waves"])
def test_interval_contains_the_skyline_of_terrain_perturbed_within_the_error_model(
        cone_bounds, cone_world, pattern):
    """Move every pixel by any amount within its allowed error, measure the
    skyline of that terrain by line of sight: it stays inside the interval."""
    grid = cone_world.grids[0]
    spec = grid.spec
    rows, cols = np.indices((spec.n_rows, spec.n_cols))
    up_source = _ShiftedSource(cone_world, +1.0, *SITE, 3.0, 6.0)
    allowance = up_source.grids[0].values(rows, cols) - grid.values(rows, cols).astype(float)
    rng = np.random.default_rng(7)
    factor = {"random signs": rng.choice([-1.0, 1.0], allowance.shape),
              "all up": np.ones(allowance.shape), "all down": -np.ones(allowance.shape),
              "waves": np.sin(rows / 7.0) * np.cos(cols / 11.0)}[pattern]
    perturbed = ElevationSource([HeightGrid("perturbed", spec, grid.values(rows, cols) + factor * allowance)])
    perturbed.unknown_height_m = 0.0
    wedge, az = random_azimuths(rng, 3600, 0.1, 400)
    profile = los.azimuth_profile(perturbed, *SITE, 2.0, az)
    low = cone_bounds.skyline_deg[wedge] - cone_bounds.skyline_err_deg[wedge]
    high = cone_bounds.skyline_deg[wedge] + cone_bounds.skyline_err_deg[wedge]
    assert np.all(profile >= low) and np.all(profile <= high)


# ---- The Sun's disc: lit and blocked are what a line of sight says ------------------------

def test_sun_disc_points_classified_lit_or_blocked_agree_with_lines_of_sight(cone_bounds, cone_world):
    """Spec section 7: confirm the skyline with direct line-of-sight rays
    from the site to points on the Sun's disc. Discs are placed close to the
    skyline, where the answer is hardest. Every point classified lit must be
    reached by its ray, and every point classified blocked must be stopped."""
    rng = np.random.default_rng(11)
    wedge, az_centre = random_azimuths(rng, 3600, 0.1, 120)
    el_centre = cone_bounds.skyline_deg[wedge] + rng.uniform(-0.6, 0.6, 120)
    offsets = np.array([(dx, dy) for dx in np.linspace(-1, 1, 7) for dy in np.linspace(-1, 1, 7)
                        if dx * dx + dy * dy <= 1.0]) * SUN_RADIUS_DEG
    el = (el_centre[:, None] + offsets[None, :, 1]).ravel()
    az = (az_centre[:, None] + offsets[None, :, 0] / np.cos(np.radians(el_centre))[:, None]).ravel() % 360
    w = np.floor((az + 0.05) / 0.1).astype(int) % 3600
    sky, err = cone_bounds.skyline_deg[w], cone_bounds.skyline_err_deg[w]
    lit, blocked = el > sky + err, el < sky - err
    rays = los.ray_blocked(cone_world, *SITE, 2.0, az, el)
    print(f"\n{len(el)} disc points: {lit.sum()} lit, {blocked.sum()} blocked, "
          f"{(~lit & ~blocked).sum()} uncertain")
    assert lit.sum() > 300 and blocked.sum() > 300
    assert all(rays[i] is False for i in np.flatnonzero(lit))
    assert all(rays[i] is True for i in np.flatnonzero(blocked))


def test_a_notch_narrower_than_a_wedge_is_not_called_blocked():
    """A 300 m wall 5 km away with a 1 degree gap inside one 2 degree wedge.
    The wedge's highest terrain is the wall, but light passes through the
    gap. Using the wall alone as the bottom of the interval would call the
    gap blocked; the floor must reach down to what is seen through the gap."""
    gap = (89.5, 90.5)
    world = SyntheticElevation([RingWall(*SITE, 5_000.0, 400.0, 300.0, gap[1], gap[0])],
                               grids=[(20.0, 9_000.0)], center=SITE, beyond_maps_height_m=0.0)
    bounds = skyline_with_error(world, *SITE, mast_m=2.0, az_step_deg=2.0)
    wedge = 45                                                     # 89 to 91 degrees
    through_gap = 1.0                                              # well below the wall's 3.3 deg
    assert los.ray_blocked(world, *SITE, 2.0, [90.0], [through_gap])[0] is False
    assert bounds.nominal.lower_deg[wedge] > 3.0, "the wall is the wedge's highest terrain"
    assert through_gap > bounds.skyline_deg[wedge] - bounds.skyline_err_deg[wedge], "not called blocked"
    assert los.azimuth_profile(world, *SITE, 2.0, [90.0])[0] < 0.5


# ---- The error grows with the map's errors -----------------------------------------------

def test_error_grows_with_the_height_error_of_the_map():
    errs = []
    for sigma in (None, 0.25, 1.0):
        world = SyntheticElevation(cones(count=10), grids=[(40.0, 8_000.0)], center=SITE,
                                   beyond_maps_height_m=0.0, error_m=sigma)
        errs.append(skyline_with_error(world, *SITE, mast_m=2.0, az_step_deg=1.0).skyline_err_deg)
    assert np.all(errs[1] >= errs[0] - 1e-9) and np.all(errs[2] >= errs[1] - 1e-9)
    assert errs[2].mean() > 2 * errs[1].mean() > 2 * errs[0].mean()


def test_error_grows_with_the_horizontal_error_of_the_map():
    base = SyntheticElevation(cones(count=10), grids=[(40.0, 8_000.0)], center=SITE,
                              beyond_maps_height_m=0.0, error_m=None)
    grid = base.grids[0]
    rows, cols = np.indices((grid.spec.n_rows, grid.spec.n_cols))
    shifted = ElevationSource([HeightGrid("shifted", grid.spec, grid.values(rows, cols),
                                          horizontal_error_m=5.0)])
    shifted.unknown_height_m = 0.0
    without = skyline_with_error(base, *SITE, mast_m=2.0, az_step_deg=1.0).skyline_err_deg
    with_shift = skyline_with_error(shifted, *SITE, mast_m=2.0, az_step_deg=1.0).skyline_err_deg
    assert np.all(with_shift >= without - 1e-9) and with_shift.max() > without.max() + 0.01


def test_error_includes_the_frame_angle_and_matches_the_nominal_interval_without_map_error():
    world = SyntheticElevation([], grids=[(40.0, 12_000.0)], center=SITE, beyond_maps_height_m=0.0,
                               error_m=None)
    bounds = skyline_with_error(world, *SITE, mast_m=2.0, az_step_deg=1.0)
    dip = -math.degrees(math.acos(R_MOON_M / (R_MOON_M + 2.0)))
    assert bounds.skyline_err_deg.min() >= FRAME_ANGLE_DEG
    assert np.all(np.abs(bounds.skyline_deg - dip) <= bounds.skyline_err_deg)
    assert bounds.skyline_err_deg.max() < 1e-4


def test_the_floor_is_below_every_azimuths_skyline_on_the_nominal_map(cone_world):
    result = compute_skyline(cone_world, *SITE, mast_m=2.0, az_step_deg=0.1)
    rng = np.random.default_rng(5)
    wedge, az = random_azimuths(rng, 3600, 0.1, 800)
    profile = los.azimuth_profile(cone_world, *SITE, 2.0, az)
    assert np.all(result.floor_deg[wedge] <= profile) and np.all(profile <= result.upper_deg[wedge])
    assert np.all(result.floor_deg <= result.upper_deg)
