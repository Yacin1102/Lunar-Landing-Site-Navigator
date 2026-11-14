"""Tests for the elevation interface and the synthetic terrain backend.

Nothing here needs the real maps except the last two tests, which compare
this module's projection with the projection the map files declare for
themselves; they are skipped until the coarse maps are on disk.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

import download_data
from lunar_engine import elevation, geometry
from lunar_engine.elevation import (CoverageError, ElevationSource, GridSpec, HeightGrid,
                                    cell_max, max_pyramid, to_lat_lon, to_xy, xy_to_unit)
from lunar_engine.geometry import R_MOON_M
from lunar_engine.synthetic import Cone, Dome, RingWall, SyntheticElevation


# ---- Projection -------------------------------------------------------------------

def test_projection_matches_hand_calculation():
    """80 S is 2 R tan(5 deg) = 304,005.6 m from the pole on the sheet."""
    assert 2 * 1_737_400 * math.tan(math.radians(5)) == pytest.approx(304_005.6, abs=0.1)
    x, y = to_xy(-80.0, 0.0)
    assert (float(x), float(y)) == pytest.approx((0.0, 304_005.6), abs=0.1), "longitude 0 is toward +y"
    x, y = to_xy(-80.0, 90.0)
    assert (float(x), float(y)) == pytest.approx((304_005.6, 0.0), abs=0.1), "90 east is toward +x"
    x, y = to_xy(-80.0, 180.0)
    assert (float(x), float(y)) == pytest.approx((0.0, -304_005.6), abs=0.1)
    assert [float(v) for v in to_xy(-90.0, 123.0)] == pytest.approx([0.0, 0.0], abs=1e-6)


def test_projection_round_trip_and_longitude_range():
    rng = np.random.default_rng(3)
    lat = rng.uniform(-90, -55, 2000)
    lon = rng.uniform(-180, 180, 2000)
    back_lat, back_lon = to_lat_lon(*to_xy(lat, lon))
    assert back_lat == pytest.approx(lat, abs=1e-10)
    assert ((back_lon - lon + 180) % 360 - 180) == pytest.approx(0.0, abs=1e-8)
    assert back_lon.min() >= -180 and back_lon.max() < 180
    assert float(to_lat_lon(0.0, -1000.0)[1]) == -180.0, "the far-side meridian is reported as -180"


def test_direct_route_from_the_sheet_to_3d_agrees_with_the_trigonometric_one():
    rng = np.random.default_rng(4)
    x = rng.uniform(-900_000, 900_000, 2000)
    y = rng.uniform(-900_000, 900_000, 2000)
    direct = xy_to_unit(x, y)
    via_angles = geometry.unit_vector(*to_lat_lon(x, y))
    assert np.abs(direct - via_angles).max() < 1e-12
    assert np.linalg.norm(direct, axis=1) == pytest.approx(1.0, abs=1e-14)
    assert xy_to_unit(0.0, 0.0) == pytest.approx([0.0, 0.0, -1.0]), "the sheet's origin is the south pole"


def test_scale_factor_is_the_real_stretch_and_never_below_one():
    for lat in (-90.0, -89.0, -83.0, -75.0, -60.0):
        # Stretch measured directly: two points 1 m apart along a meridian.
        d_lat = math.degrees(1.0 / R_MOON_M)
        y0, y1 = float(to_xy(lat, 0.0)[1]), float(to_xy(lat + d_lat, 0.0)[1])
        assert float(elevation.scale_factor(lat + d_lat / 2)) == pytest.approx(y1 - y0, rel=1e-6)
    assert float(elevation.scale_factor(-90.0)) == 1.0
    assert float(elevation.scale_factor(-83.0)) == pytest.approx(1.0037, abs=1e-4)
    assert float(elevation.scale_factor(-60.0)) == pytest.approx(1.0718, abs=1e-4)


def test_points_are_never_farther_apart_on_the_moon_than_on_the_sheet():
    """The guarantee the skyline search will build on."""
    rng = np.random.default_rng(5)
    a = rng.uniform(-900_000, 900_000, (5000, 2))
    b = a + rng.uniform(-50_000, 50_000, (5000, 2)) * rng.uniform(0, 1, (5000, 1))
    on_sheet = np.linalg.norm(a - b, axis=1)
    ua, ub = xy_to_unit(a[:, 0], a[:, 1]), xy_to_unit(b[:, 0], b[:, 1])
    on_moon = 2 * R_MOON_M * np.arcsin(np.clip(np.linalg.norm(ua - ub, axis=1) / 2, 0, 1))
    assert np.all(on_moon <= on_sheet * (1 + 1e-12))
    assert (on_moon / np.maximum(on_sheet, 1e-9)).min() > 0.87


# ---- One grid ------------------------------------------------------------------------

SPEC = GridSpec(pixel_m=20.0, x_left=-1000.0, y_top=600.0, n_rows=60, n_cols=100)


def test_grid_positions_follow_the_map_file_layout():
    assert float(SPEC.x_of_col(0)) == -990.0 and float(SPEC.y_of_row(0)) == 590.0
    assert float(SPEC.x_of_col(99)) == 990.0 and float(SPEC.y_of_row(59)) == -590.0
    assert float(SPEC.col_of_x(-990.0)) == 0.0 and float(SPEC.row_of_y(590.0)) == 0.0
    assert float(SPEC.row_of_y(SPEC.y_of_row(12.25))) == pytest.approx(12.25)
    assert bool(SPEC.covers(-990.0, 590.0)) and bool(SPEC.covers(990.0, -590.0))
    assert not bool(SPEC.covers(-995.0, 0.0)), "the half pixel outside the centres cannot be interpolated"


def test_interpolation_is_exact_on_a_tilted_plane_and_at_pixel_centres():
    cols, rows = np.meshgrid(np.arange(100), np.arange(60))
    x, y = SPEC.x_of_col(cols), SPEC.y_of_row(rows)
    plane = 100.0 + 0.3 * x - 0.7 * y
    grid = HeightGrid("plane", SPEC, plane)
    rng = np.random.default_rng(6)
    px, py = rng.uniform(-990, 990, 500), rng.uniform(-590, 590, 500)
    assert grid.height_xy(px, py) == pytest.approx(100.0 + 0.3 * px - 0.7 * py, abs=1e-3)
    assert grid.height_xy(x[7, 31], y[7, 31]) == pytest.approx([plane[7, 31]], abs=1e-4)
    assert grid.height_xy(990.0, -590.0) == pytest.approx([plane[59, 99]], abs=1e-4), "last pixel centre"


def test_interpolation_between_four_pixels_by_hand():
    heights = np.zeros((60, 100))
    heights[10, 20], heights[10, 21], heights[11, 20], heights[11, 21] = 0.0, 100.0, 200.0, 300.0
    grid = HeightGrid("four", SPEC, heights)
    x = float(SPEC.x_of_col(20.25))        # a quarter of the way to column 21
    y = float(SPEC.y_of_row(10.5))         # halfway to row 11
    # top edge: 0 + 0.25*100 = 25; bottom edge: 200 + 0.25*100 = 225; halfway: 125
    assert grid.height_xy(x, y) == pytest.approx([125.0])


def test_missing_data_and_outside_points_give_nan_not_a_guess():
    heights = np.ones((60, 100))
    heights[30, 50] = np.nan
    grid = HeightGrid("hole", SPEC, heights)
    assert np.isnan(grid.height_xy(float(SPEC.x_of_col(50.4)), float(SPEC.y_of_row(29.6)))[0])
    assert grid.height_xy(float(SPEC.x_of_col(52.4)), float(SPEC.y_of_row(29.6))) == pytest.approx([1.0])
    assert np.isnan(grid.height_xy(5000.0, 0.0)[0])
    assert np.isnan(grid.error_xy(0.0, 0.0)[0]), "no error map"


def test_wrong_array_shape_is_refused():
    with pytest.raises(ValueError):
        HeightGrid("bad", SPEC, np.zeros((100, 60)))


@pytest.mark.parametrize("rows,cols", [(3, 1), (1, 3), (1, 1)])
def test_grids_too_small_to_interpolate_are_refused(rows, cols):
    """Found by review: a one-column grid crashed during interpolation."""
    with pytest.raises(ValueError, match="at least 2 x 2"):
        GridSpec(10.0, 0.0, 30.0, rows, cols)
    with pytest.raises(ValueError, match="positive"):
        GridSpec(0.0, 0.0, 30.0, 4, 4)


def test_smallest_grid_interpolates():
    grid = HeightGrid("two", GridSpec(10.0, 0.0, 20.0, 2, 2), [[0.0, 10.0], [20.0, 30.0]])
    assert grid.height_xy(10.0, 10.0) == pytest.approx([15.0])


# ---- "Highest terrain in an area" ------------------------------------------------------

def test_cell_max_is_the_highest_of_the_four_corners():
    h = np.array([[1.0, 5.0, 2.0], [3.0, 0.0, 9.0], [np.nan, 4.0, 4.0]])
    cells = cell_max(h)
    assert cells[0].tolist() == [5.0, 9.0]
    assert np.isnan(cells[1, 0]) and cells[1, 1] == 9.0


@pytest.mark.parametrize("shape", [(1, 1), (5, 7), (64, 64), (33, 100)])
def test_every_pyramid_value_is_an_upper_limit_for_everything_beneath_it(shape):
    rng = np.random.default_rng(8)
    cells = rng.normal(0.0, 1000.0, shape)
    levels = max_pyramid(cells, missing_as=11_000.0)
    assert levels[-1].shape == (1, 1) and levels[-1][0, 0] == cells.max()
    for k, level in enumerate(levels):
        size = 2 ** k
        for i in range(level.shape[0]):
            for j in range(level.shape[1]):
                beneath = cells[i * size:(i + 1) * size, j * size:(j + 1) * size]
                assert level[i, j] == beneath.max()


def test_pyramid_refuses_an_empty_array():
    with pytest.raises(ValueError, match="empty"):
        max_pyramid(np.zeros((2, 0)), missing_as=0.0)


def test_pyramid_never_assumes_unknown_terrain_is_low():
    cells = np.zeros((8, 8))
    cells[5, 2] = np.nan
    levels = max_pyramid(cells, missing_as=11_000.0)
    assert levels[-1][0, 0] == 11_000.0
    assert levels[1][2, 1] == 11_000.0 and levels[1][0, 0] == 0.0


# ---- Several maps behind one interface ---------------------------------------------------

def _flat(name, pixel, half, value, error=None, x_centre=0.0):
    n = int(2 * half / pixel)
    spec = GridSpec(pixel, x_centre - half, half, n, n)
    return HeightGrid(name, spec, np.full((n, n), value),
                      None if error is None else np.full((n, n), error))


def test_the_finest_map_covering_a_point_answers():
    source = ElevationSource([_flat("coarse", 240.0, 48_000.0, 100.0, error=5.0),
                              _flat("fine", 20.0, 4_000.0, 200.0, error=0.5)])
    assert source.names == ["fine", "coarse"], "finest first, as reported in the dem field"
    near_pole = to_lat_lon(1000.0, -2000.0)
    farther = to_lat_lon(20_000.0, 5_000.0)
    assert source.height(*near_pole) == 200.0 and source.resolution_at(*near_pole) == 20.0
    assert source.height(*farther) == 100.0 and source.resolution_at(*farther) == 240.0
    assert source.height_error(*near_pole) == 0.5 and source.height_error(*farther) == 5.0
    assert source.is_real is True


def test_no_height_is_ever_guessed_outside_the_data_or_in_a_hole():
    grid = _flat("holed", 20.0, 4_000.0, 1.0)
    grid._heights[100, 100] = np.nan
    source = ElevationSource([grid])
    with pytest.raises(CoverageError, match="no elevation data"):
        source.height(*to_lat_lon(50_000.0, 0.0))
    hole_x, hole_y = float(grid.spec.x_of_col(100.3)), float(grid.spec.y_of_row(100.3))
    with pytest.raises(CoverageError, match="missing"):
        source.height(*to_lat_lon(hole_x, hole_y))
    assert source.height_error(*to_lat_lon(0.0, 0.0)) is None


def test_service_region_limit_follows_from_the_widest_map():
    """A map reaching 304 km from the pole covers all longitudes up to 80 S."""
    source = ElevationSource([_flat("80S", 80.0, 304_000.0, 0.0)])
    assert source.service_lat_max() == pytest.approx(-80.0, abs=0.002)
    assert source.service_lat_max() < -80.0, "304,000 m is just short of the 80 S circle"


def test_service_region_uses_the_widest_map_even_if_it_is_not_the_coarsest():
    narrow_coarse = _flat("coarse", 240.0, 48_000.0, 0.0)
    wide_fine = _flat("fine", 80.0, 304_000.0, 0.0)
    assert ElevationSource([narrow_coarse, wide_fine]).service_lat_max() == pytest.approx(-80.0, abs=0.002)


def test_no_service_region_when_no_map_contains_the_pole():
    """Found by review: a map away from the pole reported a false latitude."""
    off_pole = SyntheticElevation([], grids=((100.0, 20_000.0),), center=(-85.0, 0.0))
    with pytest.raises(CoverageError):
        off_pole.height(-90.0, 0.0)
    with pytest.raises(CoverageError, match="south pole"):
        off_pole.service_lat_max()


# ---- Synthetic terrain ------------------------------------------------------------------

def test_synthetic_maps_hold_the_shape_formulas_at_pixel_centres():
    terrain = SyntheticElevation(
        [Cone(-89.9, 30.0, 2_000.0, 800.0), Dome(-89.95, -120.0, 1_500.0, -300.0)],
        grids=[(20.0, 6_000.0)], base_height_m=50.0)
    grid = terrain.grids[0]
    rows, cols = np.meshgrid(np.arange(0, 600, 37), np.arange(0, 600, 41), indexing="ij")
    lat, lon = to_lat_lon(grid.spec.x_of_col(cols), grid.spec.y_of_row(rows))
    assert grid.read(0, 600, 0, 600)[rows, cols] == pytest.approx(terrain.true_height(lat, lon), abs=1e-3)
    assert terrain.is_real is False and terrain.names == ["SYNTHETIC_20MPP"]
    assert terrain.height_error(-89.99, 0.0) == 1.0


def test_cone_and_dome_heights_by_hand():
    terrain = SyntheticElevation([Cone(-89.9, 30.0, 2_000.0, 800.0)], grids=[(10.0, 6_000.0)])
    east, north, up = geometry.enu_frame(-89.9, 30.0)

    def point(distance_m, azimuth_deg):
        angle = distance_m / R_MOON_M
        heading = math.cos(math.radians(azimuth_deg)) * north + math.sin(math.radians(azimuth_deg)) * east
        lat, lon, _ = geometry.lat_lon_radius(math.cos(angle) * up + math.sin(angle) * heading)
        return float(lat), float(lon)

    assert float(terrain.true_height(-89.9, 30.0)) == pytest.approx(800.0)
    assert float(terrain.true_height(*point(1_000.0, 77.0))) == pytest.approx(400.0, abs=1e-6)
    assert float(terrain.true_height(*point(2_500.0, 200.0))) == 0.0
    # The sampled map agrees with the cone to within what a 10 m pixel can blur.
    assert terrain.height(*point(1_000.0, 77.0)) == pytest.approx(400.0, abs=0.5)
    dome = Dome(-88.0, 0.0, 3_000.0, 600.0)
    assert float(dome.height(geometry.unit_vector(-88.0, 0.0))) == pytest.approx(600.0)


def test_ring_wall_sector_is_where_the_compass_says_even_beside_the_pole():
    """A wall 5 km from a point 3 km from the pole, covering azimuths 80 to 100: due east."""
    centre = (-89.9, 30.0)
    terrain = SyntheticElevation([RingWall(*centre, 5_000.0, 400.0, 250.0, 80.0, 100.0)],
                                 grids=[(20.0, 10_000.0)])
    east, north, up = geometry.enu_frame(*centre)

    def height_at(distance_m, azimuth_deg):
        angle = distance_m / R_MOON_M
        heading = math.cos(math.radians(azimuth_deg)) * north + math.sin(math.radians(azimuth_deg)) * east
        lat, lon, _ = geometry.lat_lon_radius(math.cos(angle) * up + math.sin(angle) * heading)
        return float(terrain.true_height(float(lat), float(lon))), terrain.height(float(lat), float(lon))

    assert height_at(5_200.0, 90.0) == (250.0, pytest.approx(250.0)), "due east: on the wall"
    assert height_at(5_200.0, 85.0)[0] == 250.0 and height_at(5_200.0, 95.0)[0] == 250.0
    for azimuth in (0.0, 70.0, 110.0, 180.0, 270.0):
        assert height_at(5_200.0, azimuth) == (0.0, pytest.approx(0.0)), f"azimuth {azimuth}: no wall"
    assert height_at(4_900.0, 90.0)[0] == 0.0 and height_at(5_500.0, 90.0)[0] == 0.0


def test_full_ring_and_sector_through_north():
    full = RingWall(-89.5, 0.0, 1_000.0, 100.0, 50.0)
    through_north = RingWall(-89.5, 0.0, 1_000.0, 100.0, 50.0, 350.0, 10.0)
    east, north, up = geometry.enu_frame(-89.5, 0.0)
    angle = 1_050.0 / R_MOON_M
    for azimuth, in_sector in ((0.0, True), (355.0, True), (9.0, True), (20.0, False), (180.0, False)):
        heading = math.cos(math.radians(azimuth)) * north + math.sin(math.radians(azimuth)) * east
        direction = math.cos(angle) * up + math.sin(angle) * heading
        assert float(full.height(direction)) == 50.0
        assert float(through_north.height(direction)) == (50.0 if in_sector else 0.0)


def test_synthetic_nested_grids_share_pixel_edges_like_the_real_maps():
    terrain = SyntheticElevation([], grids=[(20.0, 2_000.0), (80.0, 8_000.0)], center=(-89.0, 45.0))
    fine, coarse = terrain.grids
    assert fine.spec.pixel_m == 20.0 and coarse.spec.pixel_m == 80.0
    for grid in (fine, coarse):
        assert grid.spec.x_left % grid.spec.pixel_m == 0 and grid.spec.y_top % grid.spec.pixel_m == 0
    assert terrain.resolution_at(-89.0, 45.0) == 20.0
    assert terrain.resolution_at(*to_lat_lon(float(to_xy(-89.0, 45.0)[0]) + 5_000.0,
                                             float(to_xy(-89.0, 45.0)[1]))) == 80.0


# ---- Against the real map files -----------------------------------------------------------

def _coarse_paths():
    return [download_data.PYTHON_DIR / f["dest"] for f in download_data.load_manifest()
            if f["group"] == "coarse"]


@pytest.mark.realdata("coarse")
@pytest.mark.parametrize("path", _coarse_paths(), ids=lambda p: p.name)
def test_projection_is_the_one_the_map_files_declare(path):
    """The map file carries its own projection definition. Converting the same
    points with that definition (through the PROJ library) and with this
    module must give the same place on the sheet."""
    import rasterio
    from rasterio.warp import transform

    rng = np.random.default_rng(9)
    lat = rng.uniform(-90, -60, 500)
    lon = rng.uniform(-180, 180, 500)
    # Plain longitude/latitude on the same 1737.4 km sphere, as the starting system.
    geographic = rasterio.crs.CRS.from_proj4("+proj=longlat +R=1737400 +no_defs")
    with rasterio.open(path) as raster:
        xs, ys = transform(geographic, raster.crs, lon.tolist(), lat.tolist())
    mine_x, mine_y = to_xy(lat, lon)
    worst = max(np.abs(np.array(xs) - mine_x).max(), np.abs(np.array(ys) - mine_y).max())
    print(f"\n{path.name}: largest difference from the file's own projection {worst * 1e6:.3f} micrometres")
    assert worst < 1e-6, "agreement to better than a micrometre"


@pytest.mark.realdata("coarse")
@pytest.mark.parametrize("path", _coarse_paths(), ids=lambda p: p.name)
def test_map_files_are_laid_out_as_grid_spec_assumes(path):
    """Square pixels, no rotation, row 0 at the largest y, centred on the pole,
    heights relative to the 1737.4 km sphere."""
    import rasterio

    with rasterio.open(path) as raster:
        t = raster.transform
        assert t.b == 0 and t.d == 0 and t.a == -t.e > 0
        spec = GridSpec(t.a, t.c, t.f, raster.height, raster.width)
        assert raster.tags().get("AREA_OR_POINT") == "Area"
        wkt = raster.crs.to_wkt()
    assert "1737400" in wkt and "Polar_Stereographic" in wkt
    assert 'PARAMETER["latitude_of_origin",-90]' in wkt and 'PARAMETER["central_meridian",0]' in wkt
    # The pole is exactly at the middle of the grid, on a pixel corner.
    assert float(spec.col_of_x(0.0)) == spec.n_cols / 2 - 0.5
    assert float(spec.row_of_y(0.0)) == spec.n_rows / 2 - 0.5
