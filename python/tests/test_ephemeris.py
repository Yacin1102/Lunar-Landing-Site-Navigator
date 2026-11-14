"""Tests for the Sun/Earth timetable and the TypeScript fixtures.

All of these need the SPICE kernels (group ``kernels``); they are skipped
while the kernels are missing.

What is established here (spec section 13):

* The engine's Sun and Earth directions agree with JPL Horizons, an
  independent NASA service, for surface sites.
* The timetable file holds exactly what SPICE gives and is sane.
* A browser that reads the timetable, interpolates and subtracts the site
  position reproduces the direct answers far inside the 0.01 degree and
  60 second pass marks. The browser's steps are written out in Python
  (``interpolate_rows``, ``view_from_rows``) to measure this.
* How much the answer depends on the choice of ephemeris (DE440 or DE442)
  and of Moon frame (DE440-based or the DE421 one the LOLA maps use).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import spiceypy as spice

from lunar_engine import contracts, ephemeris, events_reference, spice_env

pytestmark = pytest.mark.realdata("kernels")

MOCK = contracts.REPO_DIR / "web" / "public" / "data-mock"
FIXTURES = contracts.REPO_DIR / "web" / "engine" / "tests" / "fixtures"
HORIZONS = Path(__file__).parent / "data" / "horizons_altaz.json"


@pytest.fixture(autouse=True)
def kernels():
    """Load the build kernels for each test and unload them afterwards."""
    with spice_env.loaded():
        yield


@pytest.fixture(scope="module")
def timetable():
    """The timetable as the browser sees it: the label and the Float32 rows."""
    label = json.loads((MOCK / "ephem.json").read_text(encoding="utf-8"))
    rows = np.fromfile(MOCK / "ephem.bin", dtype="<f4").reshape(-1, 6)
    return label, rows


def _az_diff(a: float, b: float) -> float:
    """Difference between two azimuths around the circle, degrees."""
    return abs((a - b + 180.0) % 360.0 - 180.0)


def _browser_view(timetable, body, lat, lon, elev_m, mast_m, t_ms):
    """Azimuth, elevation, distance the way the web app computes them."""
    label, rows = timetable
    row = ephemeris.interpolate_rows(rows, label["t0_ms"], label["step_s"], t_ms)
    vector = row[:3] if body == "SUN" else row[3:]
    return ephemeris.view_from_rows(vector, lat, lon, elev_m, mast_m)


# ---- Time conversion --------------------------------------------------------------

@pytest.mark.parametrize("utc,t_ms", [
    ("2026-11-16T00:00:00", 1_794_787_200_000),
    ("2040-01-01T00:00:00", 2_208_988_800_000),
    ("2000-01-01T12:00:00", 946_728_000_000),
    ("2031-07-04T13:37:42.250", 1_940_938_662_250),
])
def test_utc_milliseconds_convert_to_the_same_instant_as_spice_does(utc, t_ms):
    assert float(spice_env.et_from_utc_ms(t_ms)) == pytest.approx(spice.str2et(utc), abs=1e-6)


def test_disc_radii_are_the_values_in_the_constants_kernel():
    assert spice.bodvrd("SUN", "RADII", 3)[1][0] == ephemeris.SUN_RADIUS_KM
    assert spice.bodvrd("EARTH", "RADII", 3)[1][2] == ephemeris.EARTH_RADIUS_KM, "polar radius"
    assert spice.bodvrd("EARTH", "RADII", 3)[1][0] == 6378.1366, "equatorial radius"
    assert spice.bodvrd("MOON", "RADII", 3)[1][0] == 1737.4


# ---- Against JPL Horizons -----------------------------------------------------------

def test_directions_agree_with_jpl_horizons():
    """60 directions: 5 sites x 6 dates x Sun and Earth, 2026 to 2040."""
    reference = json.loads(HORIZONS.read_text(encoding="utf-8"))
    worst_az = worst_el = 0.0
    count = 0
    for result in reference["results"]:
        assert "MEAN_ME" in result["horizons_frame_line"]
        for row in result["rows"]:
            az, el, _ = ephemeris.direct_view(result["body"], result["lat"], result["lon"],
                                              result["elev_m"], 0.0, row["t_ms"])
            worst_az = max(worst_az, _az_diff(az, row["az_deg"]))
            worst_el = max(worst_el, abs(el - row["el_deg"]))
            count += 1
    print(f"\nHorizons comparison over {count} directions: "
          f"worst azimuth difference {worst_az:.2e} deg, worst elevation difference {worst_el:.2e} deg")
    assert count == 60
    assert worst_el < 1e-6 and worst_az < 1e-6


def test_browser_method_agrees_with_jpl_horizons(timetable):
    reference = json.loads(HORIZONS.read_text(encoding="utf-8"))
    worst = 0.0
    for result in reference["results"]:
        for row in result["rows"]:
            az, el, _ = _browser_view(timetable, result["body"], result["lat"], result["lon"],
                                      result["elev_m"], 0.0, row["t_ms"])
            worst = max(worst, _az_diff(az, row["az_deg"]), abs(el - row["el_deg"]))
    print(f"\nTimetable + browser arithmetic against Horizons: worst difference {worst:.2e} deg")
    assert worst < 5e-5


# ---- The timetable file ---------------------------------------------------------------

def test_timetable_file_matches_its_contract_and_spans_the_required_dates(timetable):
    label, rows = timetable
    assert contracts.ephem_problems(label, MOCK / "ephem.bin") == []
    assert label["t0_ms"] == 1_794_787_200_000 and label["step_s"] == 3600
    assert label["count"] == len(rows) == 115_057
    last_ms = label["t0_ms"] + (label["count"] - 1) * label["step_s"] * 1000
    assert last_ms == 2_208_988_800_000, "last row is 1 Jan 2040 00:00 UTC"
    assert label["aberration"] == "LT+S" and label["frame"] == "MOON_ME"


def test_timetable_rows_are_exactly_what_spice_gives(timetable):
    label, rows = timetable
    indices = np.array([0, 1, 2, 4321, 57_000, 99_999, 115_055, 115_056])
    direct = ephemeris.moon_centre_vectors(label["t0_ms"] + indices * label["step_s"] * 1000)
    assert np.array_equal(rows[indices], direct.astype(np.float32))


def test_timetable_is_sane(timetable):
    _, rows = timetable
    sun_km = np.linalg.norm(rows[:, :3], axis=1)
    earth_km = np.linalg.norm(rows[:, 3:], axis=1)
    off_x = np.degrees(np.arccos(rows[:, 3] / earth_km))
    print(f"\nSun distance {sun_km.min():.0f} to {sun_km.max():.0f} km; "
          f"Earth distance {earth_km.min():.0f} to {earth_km.max():.0f} km; "
          f"Earth at most {off_x.max():.2f} deg from +x")
    assert 1.46e8 < sun_km.min() and sun_km.max() < 1.53e8
    assert 3.55e5 < earth_km.min() and earth_km.max() < 4.08e5
    assert off_x.max() < 11.0, "the Earth stays near +x (the mean Earth direction)"
    assert np.abs(rows[:, 2] / sun_km).max() < np.sin(np.radians(1.7)), "Sun within 1.7 deg of the Moon's equator"


# ---- Is the timetable precise enough? ----------------------------------------------------

def test_interpolating_the_timetable_adds_negligible_error(timetable):
    """500 random sites and times: the browser's method against direct SPICE.

    Two things separate the browser's answer from the direct one. The first
    is the timetable itself: hourly rows, stored as Float32, interpolated.
    The second is built into Contract 1: the timetable holds what is seen
    from the Moon's centre, and the browser shifts it to the site by
    subtracting the site's position. The light-time and aberration
    corrections were worked out for the centre, not for the site (see
    ``test_the_shift_to_the_site_is_exact_without_light_corrections``).
    """
    label, rows = timetable
    rng = np.random.default_rng(7)
    worst_cubic = {"SUN": 0.0, "EARTH": 0.0}
    worst_table = {"SUN": 0.0, "EARTH": 0.0}
    worst_shift = {"SUN": 0.0, "EARTH": 0.0}
    worst_linear = 0.0
    for _ in range(500):
        lat, lon = rng.uniform(-90, -80), rng.uniform(-180, 180)
        elev, mast = rng.uniform(-4000, 6000), 2.0
        t_ms = float(rng.integers(ephemeris.T0_MS, ephemeris.END_MS))
        for body in ("SUN", "EARTH"):
            az, el, _ = ephemeris.direct_view(body, lat, lon, elev, mast, t_ms)
            az_c, el_c, _ = _browser_view(timetable, body, lat, lon, elev, mast, t_ms)
            # Azimuth error counts as it appears on the sky: scaled by cos(elevation).
            worst_cubic[body] = max(worst_cubic[body], abs(el_c - el),
                                    _az_diff(az_c, az) * np.cos(np.radians(el)))
            # The timetable's own share: against the exact Moon-centre vector at this time.
            exact = ephemeris.moon_centre_vectors([t_ms])[0]
            az_x, el_x, _ = ephemeris.view_from_rows(exact[:3] if body == "SUN" else exact[3:],
                                                     lat, lon, elev, mast)
            worst_table[body] = max(worst_table[body], abs(el_c - el_x),
                                    _az_diff(az_c, az_x) * np.cos(np.radians(el)))
            # The shift's share: exact Moon-centre vector minus site, against direct.
            worst_shift[body] = max(worst_shift[body], abs(el_x - el),
                                    _az_diff(az_x, az) * np.cos(np.radians(el)))
            x = (t_ms - label["t0_ms"]) / (label["step_s"] * 1000.0)
            i = int(x)
            linear = rows[i] * (1 - (x - i)) + rows[min(i + 1, len(rows) - 1)] * (x - i)
            vector = linear[:3] if body == "SUN" else linear[3:]
            az_l, el_l, _ = ephemeris.view_from_rows(vector, lat, lon, elev, mast)
            worst_linear = max(worst_linear, abs(el_l - el), _az_diff(az_l, az) * np.cos(np.radians(el)))
    print(f"\nBrowser method against direct SPICE, 500 sites and times: worst error "
          f"Sun {worst_cubic['SUN']:.2e} deg, Earth {worst_cubic['EARTH']:.2e} deg. "
          f"Of that, hourly rows + Float32 + cubic interpolation: Sun {worst_table['SUN']:.2e}, "
          f"Earth {worst_table['EARTH']:.2e}. Shift from the Moon's centre to the site: "
          f"Sun {worst_shift['SUN']:.2e}, Earth {worst_shift['EARTH']:.2e}. "
          f"With straight-line interpolation instead: {worst_linear:.2e} deg in total.")
    assert worst_table["SUN"] < 1e-5 and worst_table["EARTH"] < 1e-5
    assert worst_cubic["SUN"] < 1e-5
    assert worst_cubic["EARTH"] < 5e-5
    assert worst_linear < 5e-4


def test_the_shift_to_the_site_is_exact_without_light_corrections():
    """Where the Earth's 0.000027 degrees comes from.

    With no light-time or aberration correction, "Moon-centre vector minus
    site position" and "seen from the site" are the same thing and agree to
    rounding. With the corrections they differ, because the corrections in
    the timetable were worked out for the Moon's centre.
    """
    rng = np.random.default_rng(11)
    worst = {"NONE": 0.0, "LT+S": 0.0}
    for _ in range(100):
        lat, lon = rng.uniform(-90, -80), rng.uniform(-180, 180)
        t_ms = float(rng.integers(ephemeris.T0_MS, ephemeris.END_MS))
        for correction in worst:
            centre = ephemeris.moon_centre_vectors([t_ms], correction)[0][3:]
            az_s, el_s, _ = ephemeris.view_from_rows(centre, lat, lon, 0.0, 2.0)
            az_d, el_d, _ = ephemeris.direct_view("EARTH", lat, lon, 0.0, 2.0, t_ms, correction)
            worst[correction] = max(worst[correction], abs(el_s - el_d),
                                    _az_diff(az_s, az_d) * np.cos(np.radians(el_d)))
    print(f"\nEarth, Moon-centre vector minus site against seen-from-site: "
          f"{worst['NONE']:.2e} deg with no corrections, {worst['LT+S']:.2e} deg with LT+S")
    assert worst["NONE"] < 1e-9
    assert 1e-6 < worst["LT+S"] < 5e-5


def test_interpolation_returns_the_rows_themselves_and_refuses_times_outside(timetable):
    label, rows = timetable
    t0, step_ms = label["t0_ms"], label["step_s"] * 1000
    for i in (0, 1, 500, len(rows) - 2, len(rows) - 1):
        assert ephemeris.interpolate_rows(rows, t0, label["step_s"], t0 + i * step_ms) == pytest.approx(
            rows[i].astype(float), rel=1e-12)
    with pytest.raises(ValueError):
        ephemeris.interpolate_rows(rows, t0, label["step_s"], t0 - 1)
    with pytest.raises(ValueError):
        ephemeris.interpolate_rows(rows, t0, label["step_s"], t0 + len(rows) * step_ms)


# ---- Sensitivity to the kernel choice -------------------------------------------------------

def _directions(times_ms):
    site = ephemeris.site_vector_km(-85.0, 40.0)
    vectors = ephemeris.moon_centre_vectors(times_ms)
    out = np.concatenate([vectors[:, :3] - site, vectors[:, 3:] - site])
    return out / np.linalg.norm(out, axis=1, keepdims=True)


def test_de442_gives_the_same_directions_as_de440():
    times = np.linspace(ephemeris.T0_MS, ephemeris.END_MS, 400)
    with spice_env.loaded(spice_env.BUILD_KERNELS):
        de440 = _directions(times)
    with spice_env.loaded(spice_env.DE442_KERNELS):
        de442 = _directions(times)
    angle = np.degrees(np.arctan2(np.linalg.norm(np.cross(de440, de442), axis=1),
                                  (de440 * de442).sum(axis=1)))
    print(f"\nDE442 against DE440, 2026 to 2040: Sun differs by at most {angle[:400].max():.2e} deg, "
          f"Earth by at most {angle[400:].max():.2e} deg")
    assert angle.max() < 1e-5


def test_moon_me_is_within_a_metre_of_the_frame_of_the_lola_maps():
    """NAIF states at most 3.07e-7 rad (0.0000176 deg, 53 cm) for 2000 to 2040."""
    worst = 0.0
    with spice_env.loaded(spice_env.WITH_DE421_FRAME):
        for t_ms in np.linspace(ephemeris.T0_MS, ephemeris.END_MS, 2000):
            rotation = spice.pxform("MOON_ME", "MOON_ME_DE421", float(spice_env.et_from_utc_ms(t_ms)))
            _, angle = spice.raxisa(rotation)
            worst = max(worst, abs(angle))
    print(f"\nMOON_ME (DE440-based) against MOON_ME_DE421, 2026 to 2040: at most {worst:.3e} rad "
          f"= {np.degrees(worst):.2e} deg = {worst * 1737400:.2f} m on the surface")
    assert np.degrees(worst) < 2e-5


# ---- The fixtures --------------------------------------------------------------------------

def test_altaz_fixture_matches_its_schema_and_direct_spice():
    fixture = json.loads((FIXTURES / "altaz.json").read_text(encoding="utf-8"))
    assert contracts.schema_problems(fixture, "altaz") == []
    assert len(fixture["cases"]) == 61
    for case in fixture["cases"]:
        args = (case["lat"], case["lon"], case["elev_m"], case["mast_m"], case["t_ms"])
        sun = ephemeris.direct_view("SUN", *args)
        earth = ephemeris.direct_view("EARTH", *args)
        assert (case["sunEl"], case["earthEl"]) == pytest.approx((sun[1], earth[1]), abs=1e-7)
        assert _az_diff(case["sunAz"], sun[0]) < 1e-6 and _az_diff(case["earthAz"], earth[0]) < 1e-6


def test_altaz_fixture_covers_what_it_claims():
    cases = json.loads((FIXTURES / "altaz.json").read_text(encoding="utf-8"))["cases"]
    by_name = {c["name"]: c for c in cases}
    plus, minus = by_name["longitude +180, halfway between rows"], by_name["longitude -180, halfway between rows"]
    assert (plus["sunAz"], plus["sunEl"]) == (minus["sunAz"], minus["sunEl"]), "+180 and -180 are one place"
    assert {c["t_ms"] for c in cases} >= {ephemeris.T0_MS, ephemeris.END_MS}, "both ends of the timetable"
    assert min(c["lat"] for c in cases) <= -89.9999 and max(c["lat"] for c in cases) == -80.0
    assert min(c["elev_m"] for c in cases) <= -4000 and max(c["elev_m"] for c in cases) >= 6000
    quadrants = {(c["lon"] >= 0, abs(c["lon"]) >= 90) for c in cases}
    assert len(quadrants) == 4, "near side and far side, east and west"
    assert any(c["earthEl"] > 1 for c in cases) and any(c["earthEl"] < -1 for c in cases)
    assert any(c["sunEl"] > 0 for c in cases) and any(c["sunEl"] < 0 for c in cases)


def test_browser_method_passes_the_altaz_fixture_with_a_wide_margin(timetable):
    """The pass mark for TypeScript is 0.01 degrees."""
    cases = json.loads((FIXTURES / "altaz.json").read_text(encoding="utf-8"))["cases"]
    worst = 0.0
    for case in cases:
        args = (case["lat"], case["lon"], case["elev_m"], case["mast_m"], case["t_ms"])
        sun = _browser_view(timetable, "SUN", *args)
        earth = _browser_view(timetable, "EARTH", *args)
        worst = max(worst, abs(sun[1] - case["sunEl"]), abs(earth[1] - case["earthEl"]),
                    _az_diff(sun[0], case["sunAz"]) * np.cos(np.radians(sun[1])),
                    _az_diff(earth[0], case["earthAz"]) * np.cos(np.radians(earth[1])))
    print(f"\nBrowser method on the 61 alt/az cases: worst error {worst:.2e} deg (pass mark 0.01)")
    assert worst < 1e-4


def _events():
    return json.loads((FIXTURES / "events.json").read_text(encoding="utf-8"))["cases"]


def test_events_fixture_matches_its_schema_and_has_slow_polar_windows():
    fixture = json.loads((FIXTURES / "events.json").read_text(encoding="utf-8"))
    assert contracts.schema_problems(fixture, "events") == []
    cases = fixture["cases"]
    assert len(cases) == 8
    assert max(c["end_ms"] - c["start_ms"] for c in cases) == 400 * 86_400_000
    assert min(c["start_ms"] for c in cases) == ephemeris.T0_MS
    assert max(c["end_ms"] for c in cases) == ephemeris.END_MS
    for case in cases:
        for key in ("sunrise_ms", "sunset_ms", "earthrise_ms", "earthset_ms"):
            times = case[key]
            assert times == sorted(times) and all(case["start_ms"] <= t <= case["end_ms"] for t in times)
        assert abs(len(case["sunrise_ms"]) - len(case["sunset_ms"])) <= 1, "rises and sets alternate"
        assert abs(len(case["earthrise_ms"]) - len(case["earthset_ms"])) <= 1


def test_every_fixture_event_is_a_real_crossing_of_the_upper_edge():
    """Independent of how the events were found: one second before and one
    second after each stored time, the upper edge is on opposite sides of
    the horizon, in the right order."""
    checked = 0
    for case in _events():
        for body, rise_key, set_key in (("SUN", "sunrise_ms", "sunset_ms"),
                                        ("EARTH", "earthrise_ms", "earthset_ms")):
            edge = events_reference.direct_edge_elevation(body, case["lat"], case["lon"])
            for t in case[rise_key]:
                assert edge(t - 1000) < 0 < edge(t + 1000), (case["name"], body, "rise", t)
                checked += 1
            for t in case[set_key]:
                assert edge(t - 1000) > 0 > edge(t + 1000), (case["name"], body, "set", t)
                checked += 1
    print(f"\n{checked} fixture events confirmed as crossings within one second")
    assert checked > 80


def test_a_finer_scan_finds_the_same_events():
    """Second method: a finer first scan must not find more or fewer events.

    Two ordinary windows are rescanned every 2 minutes instead of every 10.
    The two windows beside the pole, where grazes happen, are rescanned every
    5 minutes: the 200-day one for both bodies, the 400-day one for the Sun.
    The smallest margin by which a turning point missed the horizon is
    printed; the fixture builder refuses anything under 0.002 degrees.
    """
    cases = _events()
    plan = [(cases[0], ("SUN", "EARTH"), 120.0), (cases[1], ("SUN", "EARTH"), 120.0),
            (cases[5], ("SUN", "EARTH"), 300.0), (cases[4], ("SUN",), 300.0)]
    keys = {"SUN": ("sunrise_ms", "sunset_ms"), "EARTH": ("earthrise_ms", "earthset_ms")}
    assert "0.5 degrees from the pole" in cases[5]["name"] and "0.1 degrees from the pole" in cases[4]["name"]
    for case, bodies, step in plan:
        for body in bodies:
            edge = events_reference.direct_edge_elevation(body, case["lat"], case["lon"])
            fine = events_reference.find_events(edge, case["start_ms"], case["end_ms"], scan_step_s=step)
            assert fine["rise_ms"] == pytest.approx(case[keys[body][0]], abs=1), (case["name"], body)
            assert fine["set_ms"] == pytest.approx(case[keys[body][1]], abs=1), (case["name"], body)
            print(f"\n{case['name']} / {body}: same events with a {step:.0f} s scan; "
                  f"closest graze {fine['closest_graze_deg']:.4f} deg")
            assert fine["closest_graze_deg"] >= 0.002


def test_browser_method_passes_the_events_fixture_with_a_wide_margin(timetable):
    """The pass mark for TypeScript is 60 seconds."""
    radius = events_reference.BODY_RADIUS_KM
    worst_s, worst_where = 0.0, ""
    for case in _events():
        for body, rise_key, set_key in (("SUN", "sunrise_ms", "sunset_ms"),
                                        ("EARTH", "earthrise_ms", "earthset_ms")):
            def edge(t_ms, body=body):
                _, el, distance = _browser_view(timetable, body, case["lat"], case["lon"], 0.0, 0.0, t_ms)
                return el + ephemeris.angular_radius_deg(radius[body], distance)

            found = events_reference.find_events(edge, case["start_ms"], case["end_ms"])
            assert len(found["rise_ms"]) == len(case[rise_key]), (case["name"], body)
            assert len(found["set_ms"]) == len(case[set_key]), (case["name"], body)
            for a, b in zip(found["rise_ms"] + found["set_ms"], case[rise_key] + case[set_key]):
                if abs(a - b) / 1000.0 > worst_s:
                    worst_s, worst_where = abs(a - b) / 1000.0, f"{body}, {case['name']}"
    print(f"\nBrowser method on the 8 event windows: worst timing error {worst_s:.3f} s "
          f"(pass mark 60), at: {worst_where}")
    assert worst_s < 5.0


def test_event_finder_catches_a_graze_between_scan_points():
    """A curve that pokes 0.001 above zero for under a minute, between samples."""
    centre = 1_800_000_000_000 + 317_000           # not on a scan point

    def edge(t_ms):
        return 0.001 - ((t_ms - centre) / 30_000.0) ** 2 * 0.001   # positive for +/- 30 s

    found = events_reference.find_events(edge, centre - 7_200_000, centre + 7_200_000)
    assert found["rise_ms"] == pytest.approx([centre - 30_000], abs=2)
    assert found["set_ms"] == pytest.approx([centre + 30_000], abs=2)


@pytest.mark.parametrize("inside_s", [100, 250, 400])
@pytest.mark.parametrize("at_end", [False, True])
def test_event_finder_catches_a_graze_right_at_the_edge_of_the_window(inside_s, at_end):
    """A one-minute graze inside the first or last scan interval of the window."""
    start = 1_800_000_000_000
    end = start + 4 * 3_600_000
    centre = end - inside_s * 1000 if at_end else start + inside_s * 1000

    def edge(t_ms):
        return 0.001 - ((t_ms - centre) / 30_000.0) ** 2 * 0.001

    found = events_reference.find_events(edge, start, end)
    assert found["rise_ms"] == pytest.approx([centre - 30_000], abs=2)
    assert found["set_ms"] == pytest.approx([centre + 30_000], abs=2)


def test_fixture_builder_refuses_a_window_where_an_event_hangs_on_a_hair(monkeypatch):
    import build_fixtures

    monkeypatch.setattr(build_fixtures, "events_cases", lambda: [
        {"name": "fragile", "lat": -85.0, "lon": 0.0, "start_ms": 0, "end_ms": 1}])
    monkeypatch.setattr(events_reference, "smooth_moon_events", lambda *a: {
        "sunrise_ms": [], "sunset_ms": [], "earthrise_ms": [], "earthset_ms": [],
        "closest_graze_deg": 0.0019})
    with pytest.raises(ValueError, match="fragile"):
        build_fixtures.build_events(log=lambda line: None)


def test_event_finder_reports_how_close_a_miss_was():
    centre = 1_800_000_000_000

    def edge(t_ms):
        return -0.0005 - ((t_ms - centre) / 3_600_000.0) ** 2      # peaks 0.0005 below zero

    found = events_reference.find_events(edge, centre - 7_200_000, centre + 7_200_000)
    assert found["rise_ms"] == [] and found["set_ms"] == []
    assert found["closest_graze_deg"] == pytest.approx(0.0005, abs=1e-6)
