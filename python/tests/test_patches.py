"""Tests for terrain patches and shade grids (Contracts 4 and 5), on synthetic terrain.

Hand-calculated answers:

* On a smooth sphere the patch is exactly the sphere seen from the site's
  level plane: ``t = sqrt(R^2 - e^2 - n^2) - R``, 0 at the centre.
* A hill placed due north (away from the pole) shows in the rows above the
  centre; one due east in the columns right of it.
* Normals on the sphere tilt by the angle between verticals, ``(e/R, n/R, 1)``.
* A shade cell 2.4 km north of the site sees the sphere's horizon lower to
  the north and higher to the south, by the 0.079 degree tilt between the
  two verticals (the site's frame, interpretation 6).
"""

from __future__ import annotations

import numpy as np
import pytest

from lunar_engine import patches
from lunar_engine.geometry import R_MOON_M, lat_lon_radius
from lunar_engine.synthetic import Dome, SyntheticElevation

SITE = (-88.0, 30.0)


def sphere():
    return SyntheticElevation([], grids=((20.0, 9_000.0),), center=SITE, beyond_maps_height_m=0.0)


def offset_point(frame, east_m, north_m):
    lat, lon, _ = lat_lon_radius(frame.origin + east_m * frame.east + north_m * frame.north)
    return float(lat), float(lon)


def test_a_smooth_sphere_gives_the_exact_curvature():
    frame = patches.SiteFrame(sphere(), *SITE)
    heights = frame.terrain_patch(n=21, spacing_m=200.0)
    e, n = patches.patch_coordinates(21, 200.0)
    expected = np.sqrt(R_MOON_M ** 2 - e ** 2 - n ** 2) - R_MOON_M
    assert heights.dtype == np.float32 and heights.shape == (21, 21)
    assert heights[10, 10] == 0.0
    assert heights == pytest.approx(expected, abs=2e-3)
    assert heights[0, 0] == pytest.approx(-(2000 ** 2 + 2000 ** 2) / (2 * R_MOON_M), abs=0.01)   # -2.3 m


@pytest.mark.parametrize("east_m, north_m, where", [(0.0, 1600.0, "north"), (1600.0, 0.0, "east")])
def test_a_hill_shows_on_the_right_side(east_m, north_m, where):
    frame = patches.SiteFrame(sphere(), *SITE)
    hill = Dome(*offset_point(frame, east_m, north_m), radius_m=300.0, height_m=200.0)
    terrain = SyntheticElevation([hill], grids=((20.0, 9_000.0),), center=SITE, beyond_maps_height_m=0.0)
    heights = patches.SiteFrame(terrain, *SITE).terrain_patch(n=21, spacing_m=200.0)
    row, col = np.unravel_index(np.argmax(heights), heights.shape)
    # Rows run north to south and columns west to east: north is row 10 - 8, east is column 10 + 8.
    assert (row, col) == ((2, 10) if where == "north" else (10, 18))
    assert heights[row, col] > 190


def test_normals_on_a_sphere_tilt_with_the_vertical():
    frame = patches.SiteFrame(sphere(), *SITE)
    normals = frame.normals(n=5, spacing_m=1000.0)
    assert normals.shape == (5, 5, 3) and normals.dtype == np.float32
    assert normals[2, 2] == pytest.approx([0, 0, 1], abs=1e-6)
    e, n = patches.patch_coordinates(5, 1000.0)
    expected = np.stack([e / R_MOON_M, n / R_MOON_M, np.ones_like(e)], axis=-1)
    expected /= np.linalg.norm(expected, axis=-1, keepdims=True)
    assert normals == pytest.approx(expected, abs=1e-5)
    assert np.linalg.norm(normals, axis=-1) == pytest.approx(1.0, abs=1e-6)


def test_a_shade_cell_skyline_is_turned_into_the_sites_frame():
    source = sphere()
    frame = patches.SiteFrame(source, *SITE)
    dip = np.degrees(np.arccos(R_MOON_M / (R_MOON_M + 2.0)))           # horizon dip at a 2 m eye
    centre = patches.cell_skyline(source, frame, frame.origin, 2.0)
    assert len(centre) == 360
    assert centre == pytest.approx(-dip, abs=0.006)

    d = 2400.0
    point = frame.ground(np.array(0.0), np.array(d))[1]
    cell = patches.cell_skyline(source, frame, point, 2.0)
    tilt = np.degrees(d / R_MOON_M)                                      # 0.079 degrees
    assert cell[0] == pytest.approx(-dip - tilt, abs=0.006)              # looking north
    assert cell[180] == pytest.approx(-dip + tilt, abs=0.006)            # looking south (toward the site)
    assert cell[90] == pytest.approx(-dip, abs=0.006)



def test_a_shade_cell_near_the_pole_where_the_meridians_converge():
    """Found by the build: 6 km from the pole, a cell 2.4 km to the east has its "north"
    about 22 degrees away from the site's. Every stored wedge must still get a value, and
    the sphere's horizon must come out where geometry puts it."""
    site = (-89.8, 0.0)
    source = SyntheticElevation([], grids=((20.0, 9_000.0),), center=site, beyond_maps_height_m=0.0)
    frame = patches.SiteFrame(source, *site)
    d = 2400.0
    point = frame.ground(np.array(d), np.array(0.0))[1]
    _, cell_lon, _ = lat_lon_radius(point)
    assert abs(float(cell_lon)) > 20, "the meridians really do differ by many degrees here"
    cell = patches.cell_skyline(source, frame, point, 2.0)
    dip = np.degrees(np.arccos(R_MOON_M / (R_MOON_M + 2.0)))
    tilt = np.degrees(d / R_MOON_M)
    azimuth = np.radians(np.arange(360))
    expected = -dip - tilt * np.sin(azimuth)          # lower toward the east (away from the site), higher to the west
    assert cell == pytest.approx(expected, abs=0.006)


def test_a_narrow_peak_raises_only_its_own_stored_wedge():
    """Found by review: a margin made every stored wedge the highest of three. A peak
    6 km away and 0.8 degrees wide, centred in the 37 degree wedge, must raise only it."""
    from lunar_engine.synthetic import Cone

    frame = patches.SiteFrame(sphere(), *SITE)
    az = np.radians(37.0)
    peak = Cone(*offset_point(frame, 6000 * np.sin(az), 6000 * np.cos(az)), base_radius_m=40.0, height_m=200.0)
    source = SyntheticElevation([peak], grids=((10.0, 7_000.0),), center=SITE, beyond_maps_height_m=0.0)
    frame = patches.SiteFrame(source, *SITE)
    values = patches.cell_skyline(source, frame, frame.origin, 2.0)
    dip = np.degrees(np.arccos(R_MOON_M / (R_MOON_M + 2.0)))
    assert values[37] > 1.5                                   # the peak: atan(198 / 6000) = 1.9 degrees
    others = np.delete(values, 37)
    assert others == pytest.approx(-dip, abs=0.006), "no neighbouring wedge is raised"

# --------------------------------------------------------------------------
# The real products (committed files in web/public/data)
# --------------------------------------------------------------------------

def test_real_terrain_patches_and_shade_grid_centres_agree_with_the_sites_skylines():
    """The centre cell is the site itself. Its 1 degree skyline must lie within the site's
    proven 0.1 degree skyline (the highest of the ten sub-wedges, with their error bound),
    widened by the shade grid's display error: 0.01 degree interval, 0.0015 degree rounding."""
    import json

    from lunar_engine import sites

    folder = sites.SITES_PATH.parent
    listed = sites.load_sites()
    assert all(site["has_terrain"] for site in listed), "every site has its terrain patch"
    for site in listed:
        record = json.loads((folder / "skylines" / f"{site['id']}.json").read_text(encoding="utf-8"))
        terrain = json.loads((folder / "terrain" / f"{site['id']}.json").read_text(encoding="utf-8"))
        heights = np.fromfile(folder / "terrain" / f"{site['id']}.bin", dtype="<f4").reshape(terrain["n"], terrain["n"])
        assert heights[terrain["n"] // 2, terrain["n"] // 2] == 0.0
        assert terrain["elev_m"] == pytest.approx(record["elev_m"], abs=1e-3), "same ground height as the skyline"
        if not site["has_shade_grid"]:
            continue
        label = json.loads((folder / "shade" / f"{site['id']}.json").read_text(encoding="utf-8"))
        n, n_az = label["n"], label["n_az"]
        grid = np.fromfile(folder / "shade" / f"{site['id']}_skyline.bin", dtype="<i2").reshape(n, n, n_az)
        centre = grid[n // 2, n // 2] * label["skyline_scale"]
        sky = np.asarray(record["skyline_deg"])
        err = np.asarray(record["skyline_err_deg"])
        per = int(round(label["az_step_deg"] / record["az_step_deg"]))             # 10 sub-wedges
        # Stored wedge k spans k - 0.5 .. k + 0.5 degrees. Sub-wedges k*10 - 4 .. k*10 + 4 lie
        # wholly inside it (they set its floor); k*10 - 5 and k*10 + 5 half overlap (ceiling only).
        k = np.arange(n_az)[:, None] * per
        half = per // 2
        top = (sky + err)[(k + np.arange(-half, half + 1)) % len(sky)].max(axis=1)
        bottom = (sky - err)[(k + np.arange(-half + 1, half)) % len(sky)].max(axis=1)
        slack = 0.01 + label["skyline_scale"] / 2 + 1e-6
        assert np.all(centre <= top + slack) and np.all(centre >= bottom - slack), site["id"]
        normals = np.fromfile(folder / "shade" / f"{site['id']}_normal.bin", dtype="<f4").reshape(n, n, 3)
        assert np.linalg.norm(normals, axis=-1) == pytest.approx(1.0, abs=1e-5)
