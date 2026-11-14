"""Build the fixtures for the TypeScript tests (Contract 6).

Role
    Referee. Writes ``altaz.json`` and ``events.json`` into
    ``web/engine/tests/fixtures/``. Every number is computed directly with
    SPICE for the exact site and moment; the timetable is not used, so the
    fixtures test the browser's whole chain (reading the timetable,
    interpolating, subtracting the site position, turning a vector into
    angles, finding events).

What the cases are chosen to expose
    ``altaz.json``: sign errors (longitudes all round the pole, including
    +180 and -180, which must agree), azimuth right beside the pole,
    near-side and far-side sites, interpolation (times on a timetable row,
    one millisecond after a row, and halfway between rows), both ends of the
    timetable, and height (deep crater, high peak, tall mast).

    ``events.json``: windows long enough for the slow, grazing events of the
    pole (up to 400 days), at latitudes from 80 S to 0.1 degrees from the
    pole, on the near side, the far side and both limbs, including windows
    touching the start and the end of the timetable.

Usage (from the repository root)
    python python/scripts/build_fixtures.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lunar_engine import contracts, ephemeris, events_reference, products, spice_env  # noqa: E402

OUTPUT = contracts.REPO_DIR / "web" / "engine" / "tests" / "fixtures"
DAY_MS = 86_400_000
HOUR_MS = 3_600_000

#: An events case is refused if a turning point of the edge elevation comes
#: closer to the horizon than this without crossing, degrees: the number of
#: events would then hang on a hair.
MIN_GRAZE_MARGIN_DEG = 0.002


def _round_az(azimuth: float) -> float:
    """Round an azimuth to 7 decimals, keeping it below 360."""
    rounded = round(azimuth, 7)
    return 0.0 if rounded >= 360.0 else rounded


def altaz_cases() -> list[dict]:
    """The list of alt/az test inputs (without answers)."""
    t0, end = ephemeris.T0_MS, ephemeris.END_MS
    cases = []

    def add(name, lat, lon, elev_m, mast_m, t_ms):
        cases.append({"name": name, "lat": lat, "lon": lon, "elev_m": elev_m,
                      "mast_m": mast_m, "t_ms": int(t_ms)})

    # Longitudes all round the pole at one moment between rows.
    mid = t0 + 4321 * HOUR_MS + HOUR_MS // 2
    for lon in (0.0, 45.0, 90.0, 135.0, 180.0, -180.0, -135.0, -90.0, -45.0):
        add(f"longitude {lon:+.0f}, halfway between rows", -85.0, lon, 0.0, 2.0, mid)
    # Right beside the pole, where every direction is nearly north.
    for lat, lon in ((-89.99, 0.0), (-89.99, 123.0), (-89.9999, -77.0), (-89.5, -150.0)):
        add(f"beside the pole, latitude {lat}", lat, lon, 0.0, 2.0, mid + 7 * DAY_MS)
    # Timetable edges and positions within a row.
    for name, t in (("first row exactly", t0), ("1 ms after the first row", t0 + 1),
                    ("halfway through the first interval", t0 + HOUR_MS // 2),
                    ("second row exactly", t0 + HOUR_MS),
                    ("halfway through the last interval", end - HOUR_MS // 2),
                    ("1 ms before the last row", end - 1), ("last row exactly", end)):
        add(f"timetable edge: {name}", -88.0, 30.0, 0.0, 2.0, t)
        add(f"timetable edge: {name}, far side", -84.0, -160.0, 0.0, 2.0, t)
    # Height: deep crater floor, high peak, tall mast, ground level.
    for name, elev, mast in (("crater floor 4 km deep", -4000.0, 2.0), ("peak 6 km high", 6000.0, 2.0),
                             ("100 m mast", 500.0, 100.0), ("eye at ground level", 0.0, 0.0)):
        add(f"height: {name}", -86.5, 12.0, elev, mast, t0 + 800 * DAY_MS + 12_345_678)
        add(f"height: {name}, limb", -86.5, -92.0, elev, mast, t0 + 2900 * DAY_MS + 9_876_543)
    # The northern edge of the service region.
    add("edge of the service region, near side", -80.0, 75.0, 0.0, 2.0, t0 + 1700 * DAY_MS + 5_000_000)
    add("edge of the service region, far side", -80.0, -100.0, 0.0, 2.0, t0 + 4100 * DAY_MS + 77_777_777)
    # Random sites and times across the whole span (fixed seed: repeatable).
    rng = np.random.default_rng(20261116)
    for i in range(24):
        lat = float(np.round(rng.uniform(-90.0, -80.0), 4))
        lon = float(np.round(rng.uniform(-180.0, 180.0), 4))
        t = int(rng.integers(t0, end))
        add(f"random {i + 1}", max(lat, -89.9999), lon, float(np.round(rng.uniform(-4000, 6000), 1)),
            float(rng.choice([0.0, 2.0, 10.0])), t)
    return cases


def build_altaz() -> dict:
    """Compute the alt/az fixture. Kernels must be loaded."""
    cases = []
    for case in altaz_cases():
        args = (case["lat"], case["lon"], case["elev_m"], case["mast_m"], case["t_ms"])
        sun_az, sun_el, _ = ephemeris.direct_view("SUN", *args)
        earth_az, earth_el, _ = ephemeris.direct_view("EARTH", *args)
        cases.append({**case, "sunEl": round(sun_el, 7), "sunAz": _round_az(sun_az),
                      "earthEl": round(earth_el, 7), "earthAz": _round_az(earth_az)})
    return {"version": 1, "cases": cases}


def events_cases() -> list[dict]:
    """The list of event test windows (without answers)."""
    t0, end = ephemeris.T0_MS, ephemeris.END_MS
    return [
        {"name": "near side, 60 days from the start of the timetable",
         "lat": -85.0, "lon": 0.0, "start_ms": t0, "end_ms": t0 + 60 * DAY_MS},
        {"name": "far side, 90 days: the Earth only peeks over the horizon",
         "lat": -85.0, "lon": 180.0, "start_ms": t0 + 200 * DAY_MS, "end_ms": t0 + 290 * DAY_MS},
        {"name": "east limb, 90 days",
         "lat": -88.0, "lon": 90.0, "start_ms": t0 + 1000 * DAY_MS, "end_ms": t0 + 1090 * DAY_MS},
        {"name": "west limb, 90 days",
         "lat": -88.0, "lon": -90.0, "start_ms": t0 + 2000 * DAY_MS, "end_ms": t0 + 2090 * DAY_MS},
        {"name": "0.1 degrees from the pole, 400 days: seasonal, grazing Sun",
         "lat": -89.9, "lon": 45.0, "start_ms": t0 + 400 * DAY_MS, "end_ms": t0 + 800 * DAY_MS},
        {"name": "0.5 degrees from the pole, 200 days",
         "lat": -89.5, "lon": -150.0, "start_ms": t0 + 3000 * DAY_MS, "end_ms": t0 + 3200 * DAY_MS},
        {"name": "edge of the service region, 45 days",
         "lat": -80.0, "lon": -120.0, "start_ms": t0 + 1500 * DAY_MS, "end_ms": t0 + 1545 * DAY_MS},
        {"name": "last 60 days of the timetable",
         "lat": -86.0, "lon": 30.0, "start_ms": end - 60 * DAY_MS, "end_ms": end},
    ]


def build_events(log=print) -> dict:
    """Compute the events fixture. Kernels must be loaded.

    Raises:
        ValueError: if a window is fragile (see ``MIN_GRAZE_MARGIN_DEG``).
    """
    cases = []
    for case in events_cases():
        found = events_reference.smooth_moon_events(
            case["lat"], case["lon"], case["start_ms"], case["end_ms"])
        margin = found.pop("closest_graze_deg")
        log(f"{case['name']}: {len(found['sunrise_ms'])} sunrise, {len(found['sunset_ms'])} sunset, "
            f"{len(found['earthrise_ms'])} earthrise, {len(found['earthset_ms'])} earthset; "
            f"closest graze {margin:.4f} deg")
        if margin < MIN_GRAZE_MARGIN_DEG:
            raise ValueError(f"window '{case['name']}' is fragile: a turning point lies "
                             f"{margin:.5f} degrees from the horizon; choose another window")
        cases.append({**case, **found})
    return {"version": 1, "cases": cases}


def main() -> int:
    """Write both fixture files and check them against their schemas."""
    with spice_env.loaded():
        altaz = build_altaz()
        events = build_events()
    problems = (contracts.schema_problems(altaz, "altaz")
                + contracts.schema_problems(events, "events"))
    if problems:
        print("\n".join(problems))
        return 1
    products.write_json(OUTPUT / "altaz.json", altaz)
    products.write_json(OUTPUT / "events.json", events)
    print(f"Wrote {len(altaz['cases'])} alt/az cases and {len(events['cases'])} event windows to {OUTPUT}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
