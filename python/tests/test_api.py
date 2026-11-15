"""Tests for the skyline records and the live API (Contracts 3 and 7).

What is established here:

* A live answer and a pre-made file for the same point and parameters are
  identical, because both come from ``records.skyline_record``.
* Every response, good or refused, matches its JSON Schema.
* Bad input is refused with a clear error and the right HTTP status; the
  point actually used is reported; answers are cached; the web app's origin
  is allowed and others are not.
* Rounding a record never shrinks its interval.
"""

from __future__ import annotations

import json
import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from lunar_engine import contracts, records
from lunar_engine.elevation import CoverageError
from lunar_engine.geometry import R_MOON_M, enu_frame, lat_lon_radius
from lunar_engine.server import ALLOWED_AZ_STEPS_DEG, POLE_NUDGE_LAT, create_app, parse_skyline_request
from lunar_engine.synthetic import Cone, SyntheticElevation

WEB_ORIGIN = "http://localhost:5173"


def _world():
    rng = np.random.default_rng(9)
    east, north, up = enu_frame(-89.999, 0.0)
    shapes = []
    for _ in range(8):
        t = rng.uniform(1_500.0, 4_500.0) / R_MOON_M
        a = rng.uniform(0.0, 2 * np.pi)
        lat, lon, _ = lat_lon_radius(np.cos(t) * up + np.sin(t) * (np.cos(a) * north + np.sin(a) * east))
        shapes.append(Cone(float(lat), float(lon), rng.uniform(300.0, 900.0), rng.uniform(40.0, 250.0)))
    return SyntheticElevation(shapes, grids=[(40.0, 7_000.0)], center=(-90.0, 0.0),
                              beyond_maps_height_m=0.0, error_m=0.5)


@pytest.fixture(scope="module")
def world():
    return _world()


@pytest.fixture(scope="module")
def region(world):
    return {"lat_min": -90.0, "lat_max": round(world.service_lat_max(), 5)}


@pytest.fixture(scope="module")
def client(world, region):
    return TestClient(create_app(world, service_region=region))


def _fake_record(source, lat, lon, mast, step):
    n = int(round(360 / step))
    return {"version": 1, "lat": lat, "lon": lon, "elev_m": 0.0, "mast_m": mast, "az_step_deg": step,
            "skyline_deg": [0.0] * n, "skyline_err_deg": [0.01] * n, "dem": ["FAKE"],
            "resolution_m": 40.0, "max_reach_km": 1.0}


@pytest.fixture
def fake_client(world, region):
    """An app whose computation is replaced, for the input checks."""
    return TestClient(create_app(world, service_region=region, compute=_fake_record))


def _assert_refused(response, status, code, param=None):
    body = response.json()
    assert response.status_code == status, body
    assert contracts.schema_problems(body, "api_error") == []
    assert body["error"]["code"] == code
    assert body["error"].get("param") == param
    assert body["error"]["message"]


# ---- Health -------------------------------------------------------------------------

def test_health_matches_its_schema_and_says_the_terrain_is_synthetic(client, region):
    response = client.get("/api/health")
    body = response.json()
    assert response.status_code == 200
    assert contracts.schema_problems(body, "api_health") == []
    assert body["real_terrain"] is False and body["service_region"] == region
    assert body["az_step_deg_default"] == 0.1 and 0.1 in body["az_step_deg_allowed"]
    assert body["mast_m_default"] == 2.0


# ---- A real skyline ---------------------------------------------------------------------

def test_live_answer_is_identical_to_the_prebuilt_file(client, world, tmp_path):
    """Spec section 11: a live skyline and a pre-made file for the same point
    and parameters must be identical."""
    response = client.get("/api/skyline", params={"lat": -89.98, "lon": 45.5, "mast_m": 2})
    assert response.status_code == 200, response.json()
    live = response.json()
    assert contracts.skyline_problems(live) == []
    path = records.write_skyline(tmp_path, "test_site", records.skyline_record(world, -89.98, 45.5, 2.0, 0.1))
    assert json.loads(path.read_text(encoding="utf-8")) == live
    assert live["dem"] == ["SYNTHETIC_40MPP"] and live["resolution_m"] == 40.0
    assert len(live["skyline_deg"]) == 3600


def test_the_point_actually_used_is_reported_and_answers_are_cached(world, region):
    app = create_app(world, service_region=region)
    client = TestClient(app)
    first = client.get("/api/skyline", params={"lat": "-89.9800004", "lon": "45.5000049", "az_step_deg": 1})
    assert first.status_code == 200
    assert (first.json()["lat"], first.json()["lon"]) == (-89.98, 45.5)
    computed = app.state.computed
    again = client.get("/api/skyline", params={"lat": "-89.98", "lon": "45.5", "az_step_deg": "1.0"})
    assert again.json() == first.json() and app.state.computed == computed, "served from the cache"


def test_the_request_the_web_app_makes_works(client):
    """web/src/api.ts sends lat, lon and mast_m only."""
    response = client.get("/api/skyline?lat=-89.97&lon=-120&mast_m=2", headers={"Origin": WEB_ORIGIN})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == WEB_ORIGIN
    assert response.json()["mast_m"] == 2.0 and response.json()["az_step_deg"] == 0.1


def test_a_point_whose_skyline_needs_terrain_beyond_the_maps_is_refused(client, region):
    """Inside the service region but so close to the map's edge that terrain
    beyond it could matter: refused, never answered with a cut-off."""
    response = client.get("/api/skyline", params={"lat": region["lat_max"], "lon": 0, "mast_m": 50})
    _assert_refused(response, 422, "out_of_region")
    assert "no skyline can be proven" in response.json()["error"]["message"]


# ---- Refused input -----------------------------------------------------------------------

@pytest.mark.parametrize("query,status,code,param", [
    ({}, 400, "missing_parameter", "lat"),
    ({"lat": "-89.9"}, 400, "missing_parameter", "lon"),
    ({"lat": "abc", "lon": "0"}, 400, "invalid_value", "lat"),
    ({"lat": "nan", "lon": "0"}, 400, "invalid_value", "lat"),
    ({"lat": "-89.9", "lon": "inf"}, 400, "invalid_value", "lon"),
    ({"lat": "-91", "lon": "0"}, 400, "invalid_value", "lat"),
    ({"lat": "-89.9", "lon": "200"}, 400, "invalid_value", "lon"),
    ({"lat": "-89.9", "lon": "160", "note": "x"}, 400, "invalid_value", "note"),
    ({"lat": "-89.9", "lon": "0", "mast_m": "-1"}, 400, "invalid_value", "mast_m"),
    ({"lat": "-89.9", "lon": "0", "mast_m": "500"}, 400, "invalid_value", "mast_m"),
    ({"lat": "-89.9", "lon": "0", "az_step_deg": "0.3"}, 400, "invalid_value", "az_step_deg"),
    ({"lat": "-89.9", "lon": "0", "az_step_deg": "0.7"}, 400, "invalid_value", "az_step_deg"),
    ({"lat": "-70", "lon": "0"}, 422, "out_of_region", "lat"),
    ({"lat": "10", "lon": "0"}, 422, "out_of_region", "lat"),
])
def test_bad_requests_are_refused_with_a_clear_error(fake_client, query, status, code, param):
    _assert_refused(fake_client.get("/api/skyline", params=query), status, code, param)


def test_the_pole_is_nudged_and_the_far_side_meridian_has_one_name(region):
    assert parse_skyline_request({"lat": "-90", "lon": "77"}, region)[0] == POLE_NUDGE_LAT
    assert parse_skyline_request({"lat": "-89.999999", "lon": "77"}, region)[0] == POLE_NUDGE_LAT
    assert parse_skyline_request({"lat": "-89.9", "lon": "180"}, region)[1] == -180.0
    assert parse_skyline_request({"lat": "-89.9", "lon": "179.999999"}, region)[1] == -180.0
    assert parse_skyline_request({"lat": "-89.9", "lon": "-180"}, region)[1] == -180.0
    assert parse_skyline_request({"lat": "-89.9", "lon": "0", "mast_m": "0"}, region)[2] == 0.0, \
        "an eye at ground level is accepted"


def test_every_allowed_step_divides_360():
    for step in ALLOWED_AZ_STEPS_DEG:
        assert contracts.az_count(step) is not None


def test_engine_failures_become_schema_valid_errors(world, region):
    def coverage(*args):
        raise CoverageError("needs terrain beyond the maps")

    def bad_value(*args):
        raise ValueError("bad")

    def crash(*args):
        raise RuntimeError("boom")

    query = {"lat": "-89.95", "lon": "10"}
    for compute, status, code in ((coverage, 422, "out_of_region"), (bad_value, 400, "invalid_value"),
                                  (crash, 500, "internal")):
        client = TestClient(create_app(world, service_region=region, compute=compute),
                            raise_server_exceptions=False)
        _assert_refused(client.get("/api/skyline", params=query), status, code)


def test_only_the_web_apps_origin_is_allowed(fake_client):
    allowed = fake_client.get("/api/health", headers={"Origin": WEB_ORIGIN})
    other = fake_client.get("/api/health", headers={"Origin": "https://example.org"})
    assert allowed.headers.get("access-control-allow-origin") == WEB_ORIGIN
    assert "access-control-allow-origin" not in other.headers


# ---- Rounding a record -------------------------------------------------------------------

def test_rounding_never_shrinks_the_interval():
    rng = np.random.default_rng(1)
    centre = rng.uniform(-5, 20, 20_000)
    half = rng.uniform(0, 0.5, 20_000)
    c, h = records._round_interval(centre, half)
    c, h = np.array(c), np.array(h)
    assert np.all(c - h <= centre - half + 1e-15) and np.all(c + h >= centre + half - 1e-15)
    assert np.all(np.abs(c - centre) <= 0.5e-6 + 1e-15)
    assert np.all(h - half <= 1.6e-6)
    assert all(float(f"{v:.6f}") == v for v in c[:100]), "6 decimals"


def test_site_ids_are_checked_before_a_file_is_written(tmp_path):
    record = _fake_record(None, -89.9, 0.0, 2.0, 1.0)
    with pytest.raises(ValueError):
        records.write_skyline(tmp_path, "Bad Id", record)
    assert records.write_skyline(tmp_path, "good_id-1", record).exists()
