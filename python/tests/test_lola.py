"""Tests for the LOLA map reader.

Two kinds:

* **Small GeoTIFFs written by the test** in the real maps' projection, read
  through the file-backed reader. Every answer must equal the in-memory map
  of the same numbers: heights, tables, slope bounds, trusted disc, error
  allowances, and a whole skyline. These need no downloaded data.
* **The real maps** (skipped until they are on disk): the files are read
  exactly as rasterio reads them; Shackleton crater appears where and as
  deep as published; the nested maps agree where they overlap.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

import download_data
from lunar_engine import lola
from lunar_engine.elevation import ElevationSource, GridSpec, HeightGrid, max_pyramid, cell_max, to_lat_lon, to_xy
from lunar_engine.skyline import compute_skyline

#: The projection text of the LOLA polar maps (from LDEM_80S_80MPP_ADJ.TIF).
LOLA_WKT = (
    'PROJCS["Moon (2015) - Sphere / Ocentric / South Polar",GEOGCS["Moon (2015) - Sphere / Ocentric",'
    'DATUM["Moon (2015) - Sphere",SPHEROID["Moon (2015) - Sphere",1737400,0,AUTHORITY["IAU","30100"]],'
    'AUTHORITY["IAU","30100"]],PRIMEM["Reference Meridian",0,AUTHORITY["IAU","30100"]],'
    'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["IAU","30100"]],'
    'PROJECTION["Polar_Stereographic"],PARAMETER["latitude_of_origin",-90],PARAMETER["central_meridian",0],'
    'PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],'
    'AXIS["Easting",NORTH],AXIS["Northing",NORTH],AUTHORITY["IAU","30135"]]')

#: Shackleton crater (IAU/USGS Gazetteer of Planetary Nomenclature: centre
#: 89.67 S, 129.78 E). Zuber et al. 2012 (Nature 486, 378): diameter 21 km,
#: depth/diameter 0.195 +/- 0.025, floor about 7 km across.
SHACKLETON = (-89.67, 129.78)


def write_tif(path, heights, pixel=40.0, x_left=-4_000.0, y_top=4_000.0, wkt=LOLA_WKT, area=True):
    import rasterio
    from rasterio.transform import from_origin

    with rasterio.open(path, "w", driver="GTiff", height=heights.shape[0], width=heights.shape[1],
                       count=1, dtype="float32", crs=rasterio.crs.CRS.from_user_input(wkt), nodata=float("nan"),
                       transform=from_origin(x_left, y_top, pixel, pixel), tiled=True,
                       blockxsize=64, blockysize=64, compress="deflate") as out:
        out.write(heights.astype(np.float32), 1)
        out.update_tags(AREA_OR_POINT="Area" if area else "Point")


@pytest.fixture
def pair(tmp_path, monkeypatch):
    """A small terrain written as GeoTIFFs and the same numbers in memory."""
    monkeypatch.setattr(lola, "ROWS_PER_STRIP", 48)               # several strips even on a small map
    rng = np.random.default_rng(3)
    n = 200
    rows, cols = np.indices((n, n))
    heights = (300 * np.sin(rows / 17.0) * np.cos(cols / 23.0) + rng.normal(0, 3, (n, n))).astype(np.float32)
    heights[30, 140] = np.nan                                      # a hole inside the disc
    errors = rng.uniform(0.1, 2.0, (n, n)).astype(np.float32)
    write_tif(tmp_path / "h.tif", heights)
    write_tif(tmp_path / "e.tif", errors)
    spec = GridSpec(40.0, -4_000.0, 4_000.0, n, n)
    memory = HeightGrid("memory", spec, heights, errors, horizontal_error_m=1.0)
    files = lola.LolaGrid(tmp_path / "h.tif", tmp_path / "e.tif", horizontal_error_m=1.0,
                          cache_root=tmp_path / "cache", log=lambda m: None)
    return memory, files, tmp_path


def test_heights_errors_and_layout_equal_the_in_memory_map(pair):
    memory, files, _ = pair
    assert files.spec == memory.spec
    rng = np.random.default_rng(1)
    r, c = rng.integers(0, 200, 5000), rng.integers(0, 200, 5000)
    assert np.array_equal(files.values(r, c), memory.values(r, c), equal_nan=True)
    assert np.array_equal(files.error_values(r, c), memory.error_values(r, c))
    x, y = rng.uniform(-3_980, 3_980, 3000), rng.uniform(-3_980, 3_980, 3000)
    assert np.array_equal(files.height_xy(x, y), memory.height_xy(x, y), equal_nan=True)


def test_trusted_disc_equals_the_in_memory_one(pair):
    memory, files, _ = pair
    assert files.disc() == pytest.approx(memory.disc(), abs=1e-9)
    assert files.disc()[2] < 199 * 20.0, "the hole shrank the disc"


def test_highest_terrain_tables_equal_the_in_memory_ones(pair):
    memory, files, _ = pair
    expected = max_pyramid(cell_max(memory._heights), 11_000.0)
    got = files.pyramid(11_000.0)
    assert len(got) == len(expected)
    for k, (a, b) in enumerate(zip(got, expected)):
        rows, cols = np.indices(b.shape)
        assert np.array_equal(np.asarray(a[rows.ravel(), cols.ravel()], dtype=float), b.ravel().astype(float)), k


def test_slope_bounds_equal_the_in_memory_ones(pair):
    memory, files, _ = pair
    rows, cols = np.indices((200, 200))
    assert np.allclose(files.slope_bound(rows.ravel(), cols.ravel()),
                       memory.slope_bound(rows.ravel(), cols.ravel()), equal_nan=True)


def test_error_allowances_are_never_smaller_than_the_exact_ones(pair):
    """The file-backed reader covers the shift's reach with whole 8 x 8 blocks:
    never less than the exact calculation, and not much more."""
    memory, files, _ = pair
    rows, cols = np.indices((200, 200))
    exact = memory.own_allowance(rows, cols, 3.0)
    blocks = files.own_allowance(rows, cols, 3.0)
    assert np.all(blocks >= exact - 1e-9)
    assert files.max_own_allowance(3.0) >= np.nanmax(exact)
    raised_exact = max_pyramid(cell_max(memory._heights.astype(float) + exact), 11_000.0)
    raised = files.raised_pyramid(3.0, 11_000.0)
    for a, b in zip(raised, raised_exact):
        r, c = np.indices(b.shape)
        assert np.all(np.asarray(a[r.ravel(), c.ravel()], dtype=float) >= b.ravel() - 1e-3)


def test_a_skyline_from_the_files_equals_the_one_from_memory(pair):
    memory, files, _ = pair
    lat, lon = (float(v) for v in to_lat_lon(-200.0, 300.0))
    sources = []
    for grid in (memory, files):
        source = ElevationSource([grid])
        source.unknown_height_m = 0.0
        sources.append(source)
    a = compute_skyline(sources[0], lat, lon, mast_m=2.0, az_step_deg=1.0, require_complete=False)
    b = compute_skyline(sources[1], lat, lon, mast_m=2.0, az_step_deg=1.0, require_complete=False)
    assert np.array_equal(a.lower_deg, b.lower_deg)
    assert np.array_equal(a.upper_deg, b.upper_deg) and np.array_equal(a.floor_deg, b.floor_deg)


def test_caches_are_reused_and_rebuilt_when_the_source_changes(tmp_path):
    import gc
    import os

    heights = np.arange(400, dtype=np.float32).reshape(20, 20)
    write_tif(tmp_path / "s.tif", heights)
    cache = tmp_path / "own_cache"
    first = lola.LolaGrid(tmp_path / "s.tif", cache_root=cache, log=lambda m: None)
    stamp = (cache / "s" / "heights.json").read_text()
    assert first.values(np.array([5]), np.array([7]))[0] == heights[5, 7]
    del first                                           # Windows cannot replace a file that is still open
    gc.collect()
    reused = lola.LolaGrid(tmp_path / "s.tif", cache_root=cache, log=lambda m: None)
    assert (cache / "s" / "heights.json").read_text() == stamp, "the cache was reused"
    del reused
    gc.collect()
    changed = heights.copy()
    changed[5, 7] += 500.0
    write_tif(tmp_path / "s.tif", changed)
    os.utime(tmp_path / "s.tif", (1, 2_000_000_000))    # a different date, as a new download would have
    rebuilt = lola.LolaGrid(tmp_path / "s.tif", cache_root=cache, log=lambda m: None)
    assert (cache / "s" / "heights.json").read_text() != stamp
    assert rebuilt.values(np.array([5]), np.array([7]))[0] == changed[5, 7]


@pytest.mark.parametrize("problem", ["wrong projection", "point registration"])
def test_files_laid_out_differently_are_refused(tmp_path, problem):
    heights = np.zeros((20, 20), np.float32)
    if problem == "wrong projection":
        write_tif(tmp_path / "x.tif", heights, wkt="EPSG:4326")
    else:
        write_tif(tmp_path / "x.tif", heights, area=False)
    with pytest.raises(lola.LabelError):
        lola.read_label(tmp_path / "x.tif")


# ---- The real maps ------------------------------------------------------------------

def _shackleton(source, centre=SHACKLETON):
    """Deepest point within 5 km of Shackleton's centre, and the mean rim height
    on a ring 9 to 12 km out (its 21 km diameter)."""
    from lunar_engine.geometry import R_MOON_M, enu_frame, lat_lon_radius
    east, north, up = enu_frame(*centre)

    def at(distance_m, azimuth_deg):
        t, a = distance_m / R_MOON_M, math.radians(azimuth_deg)
        lat, lon, _ = lat_lon_radius(math.cos(t) * up + math.sin(t) * (math.cos(a) * north + math.sin(a) * east))
        return float(lat), float(lon)

    floor = min((source.height(*at(d, a)), d) for d in np.arange(0.0, 5_001.0, 250.0) for a in range(0, 360, 15))
    rim = np.mean([max(source.height(*at(d, a)) for d in np.arange(9_000.0, 12_001.0, 250.0))
                   for a in range(0, 360, 10)])
    return floor, rim


@pytest.mark.realdata("coarse")
def test_coarse_maps_read_exactly_as_rasterio_reads_them():
    import rasterio
    from rasterio.windows import Window

    for heights, errors in lola.COARSE_PRODUCTS:
        grid = lola.LolaGrid(download_data.PYTHON_DIR / "dem" / heights,
                             download_data.PYTHON_DIR / "dem" / errors, log=lambda m: None)
        with rasterio.open(download_data.PYTHON_DIR / "dem" / heights) as raster:
            for r0, c0 in ((0, 0), (1234, 4321), (raster.height - 64, raster.width - 64)):
                window = raster.read(1, window=Window(c0, r0, 64, 64))
                rows, cols = np.indices((64, 64))
                assert np.array_equal(grid.values(rows + r0, cols + c0), window, equal_nan=True)


@pytest.mark.realdata("coarse")
def test_shackleton_crater_is_where_and_as_deep_as_published_on_the_80_m_map():
    source = lola.open_lola(download_data.PYTHON_DIR / "dem", lola.COARSE_PRODUCTS, log=lambda m: None)
    (floor, floor_at), rim = _shackleton(source)
    depth = rim - floor
    print(f"\n80 m map: Shackleton floor {floor:.0f} m (deepest {floor_at:.0f} m from the gazetteer centre), "
          f"rim mean {rim:.0f} m, depth {depth:.0f} m; published 4100 +/- 500 m")
    assert 3_600 < depth < 4_600
    assert floor_at <= 3_500, "the deepest point is within the 7 km floor round the published centre"
    # A mirrored or rotated read would put the crater elsewhere. Measured the
    # same way at those places, no 4 km deep crater is found.
    for centre in ((SHACKLETON[0], -SHACKLETON[1]), (SHACKLETON[0], SHACKLETON[1] - 180.0),
                   (SHACKLETON[0], 180.0 - SHACKLETON[1])):
        (other_floor, _), other_rim = _shackleton(source, centre)
        print(f"mirrored centre {centre}: depth {other_rim - other_floor:.0f} m")
        assert other_rim - other_floor < 0.75 * depth


@pytest.mark.realdata("full")
def test_full_maps_shackleton_and_agreement_where_they_overlap():
    source = lola.open_lola(download_data.PYTHON_DIR / "dem", lola.PRODUCTS, log=lambda m: None)
    (floor, floor_at), rim = _shackleton(source)
    print(f"\n10 m map: Shackleton floor {floor:.0f} m at {floor_at:.0f} m from centre, rim mean {rim:.0f} m, "
          f"depth {rim - floor:.0f} m")
    assert 3_600 < rim - floor < 4_600 and floor_at <= 3_500
    rng = np.random.default_rng(8)
    radius = 0.95 * source.grids[0].disc()[2]
    rho = radius * np.sqrt(rng.uniform(0, 1, 4000))
    angle = rng.uniform(0, 2 * np.pi, 4000)
    x, y = rho * np.sin(angle), rho * np.cos(angle)
    heights = np.array([g.height_xy(x, y) for g in source.grids])
    for name, other in zip([g.name for g in source.grids[1:]], heights[1:]):
        difference = np.abs(other - heights[0])
        print(f"{name} against the 10 m map at 4000 points: median {np.nanmedian(difference):.2f} m, "
              f"95 % {np.nanpercentile(difference, 95):.2f} m")
        assert np.nanmedian(difference) < 3.0
