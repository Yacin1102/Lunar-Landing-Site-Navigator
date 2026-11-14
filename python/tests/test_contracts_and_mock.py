"""Tests for the contract checks, the generated types and the mock data.

Three questions are answered here:

1. Is the committed mock folder ``web/public/data-mock/`` contract-exact?
2. Does the checker really catch broken files? (Each test breaks one thing.)
3. Does the mock landscape follow the geometric conventions (east is east,
   rows run north to south, the sphere's curvature is in the numbers)?
"""

from __future__ import annotations

import doctest
import json
import math
import shutil

import numpy as np
import pytest

import gen_types
from lunar_engine import contracts, geometry, mock_world
from lunar_engine.geometry import R_MOON_M

MOCK = contracts.REPO_DIR / "web" / "public" / "data-mock"


def _json(path):
    return json.loads(path.read_text(encoding="utf-8"))


# ---- Schemas and generated types ---------------------------------------------

def test_every_schema_exists_and_is_a_valid_json_schema():
    for name in contracts.SCHEMA_NAMES:
        contracts._validator(name)          # raises if missing or malformed
    on_disk = {p.name.split(".")[0] for p in contracts.SCHEMA_DIR.glob("*.schema.json")}
    assert on_disk == set(contracts.SCHEMA_NAMES)


def test_types_ts_is_exactly_what_the_schemas_generate():
    committed = gen_types.OUTPUT.read_text(encoding="utf-8")
    assert committed == gen_types.generate(), "run python python/scripts/gen_types.py"


def test_types_ts_declares_every_contract():
    text = gen_types.OUTPUT.read_text(encoding="utf-8")
    for name in ("EphemLabel", "SiteList", "Site", "Skyline", "TerrainLabel", "ShadeLabel",
                 "Manifest", "AltAzFixture", "EventsFixture", "ApiHealth", "ApiError"):
        assert f"export interface {name} {{" in text
    assert "sunAz: number;" in text and "mission?: string;" in text


def test_doctests_in_the_modules():
    for module in (geometry, contracts):
        assert doctest.testmod(module).failed == 0


# ---- The committed mock folder -------------------------------------------------

def test_mock_folder_matches_every_contract():
    # The timetable is real data and is added by the timetable step.
    assert contracts.data_folder_problems(MOCK, allow_missing_ephem=True) == []


def test_mock_folder_is_marked_mock_everywhere():
    manifest = _json(MOCK / "manifest.json")
    sites = _json(MOCK / "sites.json")["sites"]

    assert manifest["data_kind"] == "mock"
    assert len(sites) == 10
    assert all(site["id"].startswith("mock_") for site in sites)
    for site in sites:
        record = _json(MOCK / "skylines" / f"{site['id']}.json")
        assert record["dem"] == [mock_world.MOCK_DEM_NAME] and "SYNTHETIC" in record["dem"][0]


def test_mock_sites_cover_the_cases_the_web_app_must_handle():
    sites = _json(MOCK / "sites.json")["sites"]

    assert sum(s["has_shade_grid"] for s in sites) == 2, "some with and some without a shade grid"
    assert any("mission" in s for s in sites) and any("mission" not in s for s in sites)
    assert {s["category"] for s in sites} == {"psr", "high_illumination", "plain"}
    longitudes = [s["lon"] for s in sites]
    assert min(longitudes) < -90 and max(longitudes) > 90, "near-side and far-side facing"
    assert min(abs(s["lat"] + 90) for s in sites) < 0.1, "one site right beside the pole"


# ---- The checker catches broken files -------------------------------------------

@pytest.fixture
def broken(tmp_path):
    """A private copy of the mock folder that a test may damage."""
    folder = tmp_path / "data"
    shutil.copytree(MOCK, folder)
    return folder


def _edit(path, change):
    data = _json(path)
    change(data)
    path.write_text(json.dumps(data), encoding="utf-8")


def _problems(folder):
    return contracts.data_folder_problems(folder, allow_missing_ephem=True)


def test_checker_catches_a_skyline_with_one_entry_missing(broken):
    _edit(broken / "skylines/mock_peak.json", lambda d: d["skyline_deg"].pop())
    assert any("skyline_deg has 3599 entries, expected 3600" in p for p in _problems(broken))


def test_checker_catches_an_unknown_field_and_a_missing_field(broken):
    _edit(broken / "skylines/mock_peak.json", lambda d: d.update(extra=1))
    _edit(broken / "skylines/mock_ridge.json", lambda d: d.pop("skyline_err_deg"))
    found = _problems(broken)
    assert any("mock_peak" in p and "extra" in p for p in found)
    assert any("mock_ridge" in p and "skyline_err_deg" in p for p in found)


def test_checker_catches_a_longitude_given_as_0_to_360(broken):
    _edit(broken / "sites.json", lambda d: d["sites"][0].update(lon=240.0))
    assert any("sites.json" in p and "240" in p for p in _problems(broken))


def test_checker_catches_a_step_that_does_not_divide_360():
    record = _json(MOCK / "skylines/mock_peak.json")
    record["az_step_deg"] = 0.7
    assert contracts.skyline_problems(record) == ["az_step_deg 0.7 does not divide 360"]


def test_checker_catches_a_truncated_terrain_file(broken):
    path = broken / "terrain/mock_peak.bin"
    path.write_bytes(path.read_bytes()[:-4])
    assert any("terrain/mock_peak" in p and "bytes, expected" in p for p in _problems(broken))


def test_checker_catches_a_terrain_patch_not_centred_on_zero(broken):
    path = broken / "terrain/mock_peak.bin"
    heights = np.fromfile(path, dtype="<f4") + np.float32(1.0)
    heights.tofile(path)
    assert any("centre value is 1.0, expected 0" in p for p in _problems(broken))


def test_checker_catches_normals_that_are_not_unit_vectors(broken):
    path = broken / "shade/mock_crater_rim_normal.bin"
    (np.fromfile(path, dtype="<f4") * np.float32(2.0)).tofile(path)
    assert any("not unit vectors" in p for p in _problems(broken))


def test_checker_catches_a_shade_file_stored_with_the_wrong_number_type(broken):
    path = broken / "shade/mock_crater_rim_skyline.bin"
    np.fromfile(path, dtype="<i2").astype("<f4").tofile(path)      # Float32 instead of Int16
    assert any("mock_crater_rim_skyline.bin" in p and "expected n*n*n_az*2" in p
               for p in _problems(broken))


def test_checker_catches_flags_that_disagree_with_the_files(broken):
    (broken / "terrain/mock_peak.bin").unlink()
    _edit(broken / "sites.json", lambda d: d["sites"][2].update(has_shade_grid=True))
    found = _problems(broken)
    assert any("terrain/mock_peak: flag is true but a file is missing" in p for p in found)
    assert any("shade/mock_peak: flag is true but a file is missing" in p for p in found)


def test_checker_catches_files_the_manifest_does_not_know(broken):
    (broken / "skylines/stray.json").write_text("{}")
    (broken / "terrain/mock_ridge.json").unlink()
    found = _problems(broken)
    assert any("skylines/stray.json exists but is not listed" in p for p in found)
    assert any("terrain/mock_ridge.json is listed but does not exist" in p for p in found)


def test_checker_catches_a_site_outside_the_service_region(broken):
    _edit(broken / "sites.json", lambda d: d["sites"][0].update(lat=-69.37))
    assert any("outside the service region" in p for p in _problems(broken))


def test_checker_requires_the_timetable_unless_told_otherwise(broken):
    assert "ephem.json: file is missing" in contracts.data_folder_problems(broken)


def test_checker_checks_the_timetable_binary(tmp_path):
    label = {"version": 1, "t0_ms": 1794787200000, "step_s": 3600, "count": 3,
             "columns": list(contracts.EPHEM_COLUMNS), "units": "km", "frame": "MOON_ME",
             "origin": "MOON", "aberration": "LT+S"}
    good = np.tile(np.array([1.5e8, 0, 0, 3.8e5, 0, 0], dtype="<f4"), (3, 1))
    path = tmp_path / "ephem.bin"

    good.tofile(path)
    assert contracts.ephem_problems(label, path) == []
    good[:2].tofile(path)
    assert contracts.ephem_problems(label, path) == ["ephem.bin is 48 bytes, expected count*6*4 = 72"]
    (good / 1000).astype("<f4").tofile(path)                          # metres mistaken for km, say
    assert len(contracts.ephem_problems(label, path)) == 2
    assert contracts.schema_problems({**label, "frame": "IAU_MOON"}, "ephem") != []
    assert contracts.schema_problems({**label, "columns": list(contracts.EPHEM_COLUMNS[::-1])}, "ephem") != []


# ---- Geometry conventions --------------------------------------------------------

@pytest.mark.parametrize("lat,lon", [(-85.0, 0.0), (-89.99, 137.0), (-80.0, -179.0), (10.0, 45.0)])
def test_local_frame_is_orthonormal_and_right_handed(lat, lon):
    east, north, up = geometry.enu_frame(lat, lon)
    for a in (east, north, up):
        assert np.linalg.norm(a) == pytest.approx(1.0, abs=1e-12)
    assert np.cross(east, north) == pytest.approx(up, abs=1e-12)
    assert up == pytest.approx(geometry.unit_vector(lat, lon), abs=1e-12)
    assert north[2] > 0, "north points toward the north pole, away from the south pole"


def test_azimuth_is_from_north_clockwise_and_elevation_is_above_the_level_plane():
    east, north, up = geometry.enu_frame(-88.0, 30.0)
    directions = np.array([north, east, -north, -east, up, north + up])
    az, el = geometry.az_el_in_frame(directions, east, north, up)
    assert az[:4] == pytest.approx([0.0, 90.0, 180.0, 270.0], abs=1e-9)
    assert el[:5] == pytest.approx([0.0, 0.0, 0.0, 0.0, 90.0], abs=1e-9)
    assert (az[5], el[5]) == pytest.approx((0.0, 45.0), abs=1e-9)


def test_lat_lon_round_trip_and_longitude_range():
    lat, lon, radius = geometry.lat_lon_radius(1737.4 * geometry.unit_vector(-87.5, 179.5))
    assert (float(lat), float(lon), float(radius)) == pytest.approx((-87.5, 179.5, 1737.4), abs=1e-9)
    assert float(geometry.lat_lon_radius(geometry.unit_vector(-80.0, 200.0))[1]) == pytest.approx(-160.0)


# ---- The mock landscape follows the conventions ------------------------------------

def test_mock_skyline_on_flat_ground_is_the_dip_of_the_horizon():
    """Hand calculation: from height h above a smooth sphere of radius R the
    horizon lies acos(R / (R + h)) below the level plane. For h = 100 m that is
    0.6147 degrees."""
    record = mock_world.site_skyline(-80.5, -150.0, 100.0, 30.0)   # far from every feature
    expected = -math.degrees(math.acos(R_MOON_M / (R_MOON_M + 100.0)))
    assert expected == pytest.approx(-0.6147, abs=1e-4)
    assert record["elev_m"] == pytest.approx(0.0, abs=1e-6)
    assert record["skyline_deg"] == pytest.approx([expected] * 12, abs=0.001)


def test_mock_skyline_matches_an_independent_calculation():
    """Second method: walk along the great circle in each direction with the
    textbook formula, in even 25 m steps, and take the steepest angle."""
    lat, lon, mast = -89.95, -30.0, 2.0
    record = _json(MOCK / "skylines/mock_near_pole.json")
    east, north, up = geometry.enu_frame(lat, lon)
    eye = (R_MOON_M + mock_world.height_at(lat, lon) + mast) * up
    distances = np.arange(25.0, 300_000.0, 25.0)
    for az_deg in (0.0, 90.0, 162.1, 251.3):
        heading = math.cos(math.radians(az_deg)) * north + math.sin(math.radians(az_deg)) * east
        angle = distances / R_MOON_M
        direction = np.cos(angle)[:, None] * up + np.sin(angle)[:, None] * heading
        ground = (R_MOON_M + mock_world.height_m(direction))[:, None] * direction
        _, elevation = geometry.az_el_in_frame(ground - eye, east, north, up)
        stored = record["skyline_deg"][round(az_deg / record["az_step_deg"])]
        assert stored == pytest.approx(float(elevation.max()), abs=mock_world.MOCK_SKYLINE_ERR_DEG)


def test_mock_mountain_appears_at_its_true_compass_bearing():
    """East really is east: the 5 km mountain at (-86, 0) seen from four sides.

    From a point at the same latitude the shortest path to the mountain bends
    toward the pole, so the bearing is about 100 degrees, not 90."""
    def bearing_to_mountain(lat, lon):
        phi1, phi2 = math.radians(lat), math.radians(-86.0)
        dlon = math.radians(0.0 - lon)
        return math.degrees(math.atan2(
            math.sin(dlon) * math.cos(phi2),
            math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlon))) % 360

    for lat, lon, roughly in ((-87.5, 0.0, 0.0), (-84.5, 0.0, 180.0),
                              (-86.0, -20.0, 100.0), (-86.0, 20.0, 260.0)):
        record = mock_world.site_skyline(lat, lon, 2.0, 1.0)
        peak_az = float(np.argmax(record["skyline_deg"]))
        expected = bearing_to_mountain(lat, lon)
        assert abs((expected - roughly + 180) % 360 - 180) < 15, "test set-up"
        assert abs((peak_az - expected + 180) % 360 - 180) <= 1.0, (lat, lon, peak_az, expected)


def test_mock_terrain_patch_on_flat_ground_is_a_true_piece_of_the_sphere():
    """Hand calculation: at horizontal distance d from the site a sphere of
    radius R lies sqrt(R^2 - d^2) - R below the level plane: 1.658 m at 2400 m."""
    label = _json(MOCK / "terrain/mock_east_plain.json")
    n, spacing = label["n"], label["spacing_m"]
    patch = np.fromfile(MOCK / "terrain/mock_east_plain.bin", dtype="<f4").reshape(n, n)
    offsets = (np.arange(n) - (n - 1) / 2) * spacing
    d2 = offsets[None, :] ** 2 + offsets[:, None] ** 2
    expected = np.sqrt(R_MOON_M ** 2 - d2) - R_MOON_M

    assert expected[n // 2, 0] == pytest.approx(-1.6577, abs=1e-4)
    assert patch[n // 2, n // 2] == 0.0
    assert np.abs(patch - expected).max() < 0.002


def test_mock_terrain_rows_run_north_to_south_and_columns_west_to_east():
    north_of_site = mock_world.terrain_patch(-86.6, 0.0, 21, 200.0)    # mountain is to the north
    east_of_site = mock_world.terrain_patch(-86.0, -9.0, 21, 200.0)    # mountain is to the east
    assert north_of_site[0].mean() > north_of_site[-1].mean() + 100, "row 0 is the north edge"
    assert east_of_site[:, -1].mean() > east_of_site[:, 0].mean() + 100, "last column is the east edge"


def test_mock_shade_grid_centre_cell_agrees_with_the_site_skyline():
    label = _json(MOCK / "shade/mock_crater_rim.json")
    n, n_az = label["n"], label["n_az"]
    raw = np.fromfile(MOCK / "shade/mock_crater_rim_skyline.bin", dtype="<i2").reshape(n, n, n_az)
    centre = raw[n // 2, n // 2] * label["skyline_scale"]
    site = _json(MOCK / "skylines/mock_crater_rim.json")
    every = round(label["az_step_deg"] / site["az_step_deg"])

    assert label["mast_m"] == site["mast_m"]
    assert centre == pytest.approx(np.array(site["skyline_deg"][::every]), abs=0.1)


def test_mock_shade_normals_are_in_the_patch_frame():
    """On flat ground the surface tilts away from the centre by distance / R,
    so a cell to the east has a normal leaning east, one to the north leaning north."""
    _, normals = mock_world.shade_grid(-85.5, 90.0, 3, 2000.0, 90.0, 2.0)
    tilt = 2000.0 / R_MOON_M
    assert normals[1, 1] == pytest.approx([0.0, 0.0, 1.0], abs=1e-6)
    assert normals[1, 2] == pytest.approx([tilt, 0.0, 1.0], abs=1e-5)     # east cell
    assert normals[0, 1] == pytest.approx([0.0, tilt, 1.0], abs=1e-5)     # north cell (row 0)
