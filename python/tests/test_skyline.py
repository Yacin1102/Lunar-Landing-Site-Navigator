"""Tests for the skyline engine, all on synthetic terrain with known answers.

Each test builds a small world from formulas (a sphere, walls, cones), works
out what the skyline must be by hand or by brute force, and checks that the
engine's guaranteed interval contains it. The traps named in spec section 7
each have a test: a peak between two sampled azimuths, a tall far peak behind
a low near ridge, east being east beside the pole, and the search reaching
the edge of the data.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from lunar_engine import skyline
from lunar_engine.elevation import CoverageError, to_lat_lon, to_xy, xy_to_unit
from lunar_engine.geometry import R_MOON_M, enu_frame, lat_lon_radius
from lunar_engine.skyline import compute_skyline, wedge_count
from lunar_engine.synthetic import Cone, RingWall, SyntheticElevation

SITE = (-89.95, 30.0)


def el_exact(height_m: float, distance_m: float, eye_m: float) -> float:
    """Hand formula: elevation angle of a point ``height_m`` above the sphere,
    ``distance_m`` along the surface, seen from an eye ``eye_m`` above the
    sphere: tan(el) = ((R + H) cos t - (R + eye)) / ((R + H) sin t), t = d / R."""
    t = distance_m / R_MOON_M
    r, re = R_MOON_M + height_m, R_MOON_M + eye_m
    return math.degrees(math.atan2(r * math.cos(t) - re, r * math.sin(t)))


def destination(lat, lon, distance_m, azimuth_deg):
    """The point ``distance_m`` along the surface from (lat, lon) at an azimuth."""
    east, north, up = enu_frame(lat, lon)
    a, t = math.radians(azimuth_deg), distance_m / R_MOON_M
    lat2, lon2, _ = lat_lon_radius(math.cos(t) * up + math.sin(t) * (math.cos(a) * north + math.sin(a) * east))
    return float(lat2), float(lon2)


def on_pixel_centre(grids, lat, lon):
    """Move a point onto the nearest pixel centre of the finest grid, so that
    a cone apex placed there is held exactly by the map."""
    spec = SyntheticElevation([], grids=grids).grids[0].spec
    x, y = (float(v) for v in to_xy(lat, lon))
    col, row = round(float(spec.col_of_x(x))), round(float(spec.row_of_y(y)))
    return tuple(float(v) for v in to_lat_lon(spec.x_of_col(col), spec.y_of_row(row)))


def view_of(lat, lon, height_m, site=SITE, eye_m=2.0):
    """Exact elevation and wedge-independent azimuth of a point, from the site's eye."""
    east, north, up = enu_frame(*site)
    eye = (R_MOON_M + eye_m) * up
    d = (R_MOON_M + height_m) * xy_to_unit(*to_xy(lat, lon)) - eye
    el = math.degrees(math.atan2(d @ up, math.hypot(d @ east, d @ north)))
    az = math.degrees(math.atan2(d @ east, d @ north)) % 360.0
    return el, az


def assert_contains(result, wedges, value):
    lo, hi = result.lower_deg[wedges], result.upper_deg[wedges]
    assert np.all(lo <= value + 1e-9) and np.all(hi >= value - 1e-9), (lo, hi, value)


# ---- Smooth sphere ----------------------------------------------------------------

@pytest.mark.parametrize("mast_m", [2.0, 10.0])
def test_smooth_sphere_gives_the_exact_dip_of_the_horizon_in_every_direction(mast_m):
    """Hand calculation: the horizon lies acos(R / (R + h)) below level:
    0.0869 deg for a 2 m mast, 0.1944 deg for 10 m."""
    world = SyntheticElevation([], grids=[(40.0, 12_000.0)], center=SITE, beyond_maps_height_m=0.0)
    result = compute_skyline(world, *SITE, mast_m=mast_m, az_step_deg=0.1)
    dip = -math.degrees(math.acos(R_MOON_M / (R_MOON_M + mast_m)))
    assert dip == pytest.approx({2.0: -0.0869, 10.0: -0.1944}[mast_m], abs=1e-4)
    assert_contains(result, slice(None), dip)
    assert result.numerical_err_deg.max() < 1e-5
    assert result.elev_m == 0.0 and result.resolution_m == 40.0
    assert result.dem == ["SYNTHETIC_40MPP"] and len(result.skyline_deg) == 3600


# ---- Walls: east is east, also beside the pole ---------------------------------------

def _wall_band(height, distance, pixel, eye):
    """The sampled wall's surface reaches height H no nearer than one pixel
    diagonal inside the true near face, and is at height H everywhere one
    pixel diagonal beyond it. So its skyline lies between these two angles."""
    diag = math.sqrt(2.0) * pixel
    return el_exact(height, distance + diag, eye), el_exact(height, distance - diag, eye)


def test_full_ring_wall_by_hand():
    pixel, distance, height = 20.0, 3_000.0, 300.0
    world = SyntheticElevation([RingWall(*SITE, distance, 400.0, height)], grids=[(pixel, 6_000.0)],
                               center=SITE, beyond_maps_height_m=0.0)
    result = compute_skyline(world, *SITE, mast_m=2.0, az_step_deg=0.5)
    low, high = _wall_band(height, distance, pixel, 2.0)
    assert 5.5 < low < high < 5.7
    assert np.all(result.lower_deg >= low - 1e-9) and np.all(result.upper_deg <= high + 1e-9)


@pytest.mark.parametrize("site", [(-89.99, 30.0), (-85.0, -120.0)], ids=["1 km from the pole", "at 85 S"])
@pytest.mark.parametrize("sector", [(80.0, 100.0), (350.0, 10.0), (170.0, 190.0), (260.0, 280.0)],
                         ids=["east", "north", "south", "west"])
def test_a_wall_appears_exactly_at_its_compass_bearing(site, sector):
    pixel, distance, height = 20.0, 2_000.0, 200.0
    world = SyntheticElevation([RingWall(*site, distance, 300.0, height, *sector)],
                               grids=[(pixel, 4_000.0)], center=site, beyond_maps_height_m=0.0)
    result = compute_skyline(world, *site, mast_m=2.0, az_step_deg=1.0)
    low, high = _wall_band(height, distance, pixel, 2.0)
    dip = -math.degrees(math.acos(R_MOON_M / (R_MOON_M + 2.0)))
    azimuth = np.arange(360.0)
    from_start = (azimuth - sector[0]) % 360.0
    span = (sector[1] - sector[0]) % 360.0
    inside = (from_start >= 1.0) & (from_start <= span - 1.0)          # wedge wholly inside the sector
    outside = (from_start > span + 2.0) & (from_start < 360.0 - 2.0)    # well clear of both ends
    assert np.all(result.lower_deg[inside] >= low - 1e-9) and np.all(result.upper_deg[inside] <= high + 1e-9)
    assert_contains(result, outside, dip)


def test_a_taller_mast_sees_the_wall_lower():
    world = SyntheticElevation([RingWall(*SITE, 1_500.0, 300.0, 100.0)], grids=[(20.0, 3_000.0)],
                               center=SITE, beyond_maps_height_m=0.0)
    short = compute_skyline(world, *SITE, mast_m=2.0, az_step_deg=1.0)
    tall = compute_skyline(world, *SITE, mast_m=50.0, az_step_deg=1.0)
    assert np.all(tall.upper_deg < short.lower_deg)
    assert tall.skyline_deg.mean() == pytest.approx(el_exact(100.0, 1_500.0, 50.0), abs=0.05)


# ---- A peak between two sampled azimuths ----------------------------------------------

def test_a_narrow_peak_between_wedge_centres_is_not_missed():
    """A 300 m spike 10 km away whose whole footprint (about 0.11 degrees wide)
    lies between the centre lines of two wedges. Sampling along the wedge
    centre lines alone, as a simple ray method does, never touches it."""
    grids = [(20.0, 12_000.0)]
    apex = on_pixel_centre(grids, *destination(*SITE, 10_000.0, 45.2))
    world = SyntheticElevation([Cone(*apex, 10.0, 300.0)], grids=grids, center=SITE,
                               beyond_maps_height_m=0.0)
    step = 0.5
    el, az = view_of(*apex, 300.0)
    wedge = int(math.floor((az + step / 2) / step)) % wedge_count(step)
    footprint_deg = math.degrees(math.atan(2 * 20.0 / 10_000.0))       # +/- one pixel diagonal, generous
    assert abs(az - wedge * step) > footprint_deg / 2 and abs(az - (wedge + 1) * step) > footprint_deg / 2

    # What a ray method along the wedge centre lines would see: nothing but flat ground.
    grid = world.grids[0]
    east, north, up = enu_frame(*SITE)
    rays_max = -90.0
    for a in (wedge * step, (wedge + 1) * step):
        t = np.arange(10.0, 11_000.0, 5.0) / R_MOON_M
        heading = math.cos(math.radians(a)) * north + math.sin(math.radians(a)) * east
        u = np.cos(t)[:, None] * up + np.sin(t)[:, None] * heading
        rays_max = max(rays_max, float(np.nanmax(grid.height_xy(*_unit_to_xy(u)))))
    assert rays_max == 0.0, "the trap is real: rays along wedge centres find no spike"

    result = compute_skyline(world, *SITE, mast_m=2.0, az_step_deg=step)
    # By hand: atan(298 / 10000) = 1.707 deg, less the Moon's curvature over
    # 10 km, 10000 / (2 R) rad = 0.165 deg: 1.542 deg.
    assert el == pytest.approx(1.542, abs=0.002)
    assert_contains(result, [wedge], el)
    assert result.numerical_err_deg[wedge] < 1e-3


def _unit_to_xy(u):
    from lunar_engine.elevation import unit_to_xy
    return unit_to_xy(u)


# ---- A tall far peak behind a low near ridge -------------------------------------------

def test_a_tall_far_peak_behind_a_low_near_ridge_is_found():
    """Toward the south: a 60 m ridge 1.5 km away (about 2.2 degrees), and
    behind it an 800 m peak 9 km away (about 4.9 degrees). A search that
    stopped at the first ridge, or at a fixed distance of a few km, would
    report the ridge."""
    grids = [(20.0, 11_000.0)]
    apex = on_pixel_centre(grids, *destination(*SITE, 9_000.0, 180.0))
    world = SyntheticElevation([RingWall(*SITE, 1_500.0, 200.0, 60.0, 150.0, 210.0),
                                Cone(*apex, 1_500.0, 800.0)],
                               grids=grids, center=SITE, beyond_maps_height_m=0.0)
    result = compute_skyline(world, *SITE, mast_m=2.0, az_step_deg=0.1)
    el, az = view_of(*apex, 800.0)
    wedge = int(math.floor((az + 0.05) / 0.1)) % 3600
    ridge = el_exact(60.0, 1_500.0, 2.0)
    assert ridge == pytest.approx(2.2, abs=0.05) and el == pytest.approx(4.92, abs=0.02)
    assert_contains(result, [wedge], el)
    assert result.skyline_deg[wedge] > ridge + 2.5
    assert result.max_reach_km > 8.9, "the search had to go out to the far peak"


# ---- Never missing anything: against brute force ----------------------------------------

def test_no_terrain_point_ever_rises_above_the_proven_ceiling():
    """Random cones around the site. Brute force: 16 points in every cell of
    the map. Every one must be at or below the ceiling of its wedge."""
    rng = np.random.default_rng(1)
    shapes = []
    for _ in range(25):
        lat, lon = destination(*SITE, rng.uniform(1_000.0, 6_000.0), rng.uniform(0.0, 360.0))
        shapes.append(Cone(lat, lon, rng.uniform(200.0, 1_200.0), rng.uniform(30.0, 400.0)))
    world = SyntheticElevation(shapes, grids=[(40.0, 8_000.0)], center=SITE, beyond_maps_height_m=0.0)
    result = compute_skyline(world, *SITE, mast_m=2.0, az_step_deg=0.1)

    grid = world.grids[0]
    spec = grid.spec
    east, north, up = enu_frame(*SITE)
    eye = (R_MOON_M + result.elev_m + 2.0) * up
    sub = (np.arange(4) + 0.5) / 4
    rr = (np.arange(spec.n_rows - 1)[:, None] + sub).ravel()
    cc = (np.arange(spec.n_cols - 1)[:, None] + sub).ravel()
    x, y = np.meshgrid(spec.x_of_col(cc), spec.y_of_row(rr))
    h = grid.height_xy(x.ravel(), y.ravel())
    u = xy_to_unit(x.ravel(), y.ravel())
    d = (R_MOON_M + h)[:, None] * u - eye
    keep = np.linalg.norm(u - up, axis=1) * R_MOON_M > skyline.EXCLUDE_RADIUS_M
    el = np.degrees(np.arctan2(d @ up, np.hypot(d @ east, d @ north)))[keep]
    az = np.degrees(np.arctan2(d @ east, d @ north))[keep]
    brute = np.full(3600, -90.0)
    np.maximum.at(brute, np.floor((az + 0.05) / 0.1).astype(int) % 3600, el)

    worst = float((brute - result.upper_deg).max())
    print(f"\n{keep.sum()} brute-force points: highest above the ceiling {worst:.2e} deg (must be <= 0); "
          f"interval half-width mean {result.numerical_err_deg.mean():.5f}, "
          f"max {result.numerical_err_deg.max():.5f} deg; {result.stats['seconds']:.1f} s")
    assert worst <= 1e-9
    assert np.all(result.lower_deg <= result.upper_deg)
    # Steep cones 1 km away are the hardest case for the ceiling (it pairs a
    # piece's highest point with its nearest distance), so pieces reach the
    # subdivision limit and the interval stays a little wider than the target.
    assert result.numerical_err_deg.mean() < 0.001 and result.numerical_err_deg.max() < 0.005
    assert result.skyline_deg.max() > 3.0, "the cones really are on the skyline"


# ---- Nested maps ------------------------------------------------------------------------

def test_nested_maps_fine_near_coarse_far():
    """A 10 m map 2 km round the site and an 80 m map 20 km round it. A peak
    12 km away exists only in the coarse map and must be found there."""
    grids = [(10.0, 2_000.0), (80.0, 20_000.0)]
    coarse_spec = SyntheticElevation([], grids=grids).grids[1].spec
    target = destination(*SITE, 12_000.0, 300.0)
    x, y = (float(v) for v in to_xy(*target))
    apex = tuple(float(v) for v in to_lat_lon(coarse_spec.x_of_col(round(float(coarse_spec.col_of_x(x)))),
                                              coarse_spec.y_of_row(round(float(coarse_spec.row_of_y(y))))))
    world = SyntheticElevation([Cone(*apex, 3_000.0, 1_500.0)], grids=grids, center=SITE,
                               beyond_maps_height_m=0.0)
    result = compute_skyline(world, *SITE, mast_m=2.0, az_step_deg=0.5)
    el, az = view_of(*apex, 1_500.0)
    wedge = int(math.floor((az + 0.25) / 0.5)) % 720
    assert result.dem == ["SYNTHETIC_10MPP", "SYNTHETIC_80MPP"] and result.resolution_m == 10.0
    assert_contains(result, [wedge], el)
    # By hand: about atan(1498 / 12000) = 7.115 deg, less 12000 / (2 R) rad =
    # 0.198 deg. The apex sits on the nearest 80 m pixel centre, so use its
    # actual distance in the exact formula.
    actual_m = R_MOON_M * 2 * math.asin(np.linalg.norm(
        xy_to_unit(*to_xy(*apex)) - enu_frame(*SITE)[2]) / 2)
    assert abs(actual_m - 12_000.0) < 60.0
    assert el == pytest.approx(el_exact(1_500.0, actual_m, 2.0), abs=1e-9)
    assert el == pytest.approx(6.92, abs=0.05)


# ---- The edge of the data ------------------------------------------------------------------

def test_leaving_the_data_is_an_error_not_a_cut_off():
    """From a 100 m mast the smooth horizon is 18.6 km away, beyond a 12 km map."""
    world = SyntheticElevation([], grids=[(200.0, 12_000.0)], center=SITE, beyond_maps_height_m=0.0)
    with pytest.raises(CoverageError, match="leave the elevation data"):
        compute_skyline(world, *SITE, mast_m=100.0, az_step_deg=1.0)
    bigger = SyntheticElevation([], grids=[(200.0, 25_000.0)], center=SITE, beyond_maps_height_m=0.0)
    result = compute_skyline(bigger, *SITE, mast_m=100.0, az_step_deg=1.0)
    dip = -math.degrees(math.acos(R_MOON_M / (R_MOON_M + 100.0)))
    assert dip == pytest.approx(-0.6147, abs=1e-4)
    assert_contains(result, slice(None), dip)


def test_unknown_terrain_beyond_the_maps_is_assumed_as_high_as_any_on_the_moon():
    world = SyntheticElevation([], grids=[(40.0, 12_000.0)], center=SITE)    # beyond: unknown
    assert world.unknown_height_m == 11_000.0
    with pytest.raises(CoverageError, match="11000 m high"):
        compute_skyline(world, *SITE, mast_m=2.0, az_step_deg=1.0)


def test_a_site_outside_the_data_is_refused():
    world = SyntheticElevation([], grids=[(40.0, 4_000.0)], center=SITE, beyond_maps_height_m=0.0)
    with pytest.raises(CoverageError):
        compute_skyline(world, -88.0, 0.0)


# ---- Inputs ---------------------------------------------------------------------------------

def test_invalid_inputs_are_refused():
    world = SyntheticElevation([], grids=[(40.0, 4_000.0)], beyond_maps_height_m=0.0)
    with pytest.raises(ValueError, match="nudge"):
        compute_skyline(world, -90.0, 0.0)
    with pytest.raises(ValueError, match="divide 360"):
        compute_skyline(world, -89.99, 0.0, az_step_deg=0.7)
    with pytest.raises(ValueError, match="mast_m"):
        compute_skyline(world, -89.99, 0.0, mast_m=-1.0)
    with pytest.raises(ValueError, match="longitude"):
        compute_skyline(world, -89.99, 200.0)


def test_wedge_count_and_the_range_minimum_table():
    assert wedge_count(0.1) == 3600 and wedge_count(0.05) == 7200 and wedge_count(45) == 8
    rng = np.random.default_rng(2)
    values = rng.normal(size=100)
    table = skyline._CircularRangeMin(values)
    starts = rng.integers(-300, 300, 500)
    counts = rng.integers(1, 101, 500)
    got = table.query(starts, counts)
    for s, c, g in zip(starts, counts, got):
        assert g == values[(np.arange(c) + s) % 100].min()
