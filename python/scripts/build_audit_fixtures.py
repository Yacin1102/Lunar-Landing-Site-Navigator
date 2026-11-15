"""Write the reference values for the web engine's audit tests.

Role
    Referee for ``web/engine/tests/audit/``. Writes
    ``web/engine/tests/audit/fixtures/python_reference.json``: what the Python
    engine's reference implementation of the browser method gives for chosen
    times and sites, so the TypeScript tests compare against Python numbers,
    never against TypeScript helpers.

How it works, in plain words
    It reads the committed timetable (``web/public/data/ephem.bin``) and, for
    each case, calls ``ephemeris.interpolate_rows`` (the 4-point Lagrange
    cubic of docs/WEB_HANDOFF.md) and ``ephemeris.view_from_rows`` (site
    subtraction and east/north/up angles), plus ``angular_radius_deg`` with the
    pck00011 radii. The cases cover the first and last interval of the table,
    a row time, quarter and half points, a site 0.0001 degrees from the pole,
    and a raised eye. It needs no SPICE kernels and no maps. Nothing in the
    engine is changed; this script only calls it.

Units
    Times in UTC milliseconds since 1970, vectors in km (``MOON_ME``), angles
    in degrees, heights in metres.

Usage (from the repository root)
    python python/scripts/build_audit_fixtures.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lunar_engine import contracts, ephemeris  # noqa: E402

DATA = contracts.REPO_DIR / "web" / "public" / "data"
OUTPUT = contracts.REPO_DIR / "web" / "engine" / "tests" / "audit" / "fixtures" / "python_reference.json"
HOUR_MS = 3_600_000


def main() -> int:
    label = json.loads((DATA / "ephem.json").read_text(encoding="utf-8"))
    rows = np.fromfile(DATA / "ephem.bin", dtype="<f4").reshape(label["count"], 6)
    t0, step_ms, last = label["t0_ms"], label["step_s"] * 1000, label["count"] - 1
    times = {
        "first row": t0,
        "first interval, a quarter in": t0 + step_ms // 4,
        "first interval, halfway": t0 + step_ms // 2,
        "second interval, halfway": t0 + step_ms + step_ms // 2,
        "a row in the middle": t0 + 50_000 * step_ms,
        "a quarter after a middle row": t0 + 50_000 * step_ms + step_ms // 4,
        "one millisecond after a middle row": t0 + 50_000 * step_ms + 1,
        "last interval, halfway": t0 + (last - 1) * step_ms + step_ms // 2,
        "last row": t0 + last * step_ms,
    }
    sites = [
        ("near side, ground", -85.0, 0.0, 0.0, 0.0),
        ("far side, raised eye", -86.5, 180.0, 4500.0, 100.0),
        ("0.0001 degrees from the pole", -89.9999, 120.0, 0.0, 2.0),
    ]
    cases = []
    for time_name, t_ms in times.items():
        vector = ephemeris.interpolate_rows(rows, t0, label["step_s"], t_ms)
        for site_name, lat, lon, elev_m, mast_m in sites:
            case = {"name": f"{time_name}; {site_name}", "t_ms": int(t_ms), "lat": lat, "lon": lon,
                    "elev_m": elev_m, "mast_m": mast_m, "sun_km": vector[:3].tolist(),
                    "earth_km": vector[3:].tolist()}
            for body, part, radius in (("sun", vector[:3], ephemeris.SUN_RADIUS_KM),
                                       ("earth", vector[3:], ephemeris.EARTH_RADIUS_KM)):
                az, el, dist = ephemeris.view_from_rows(part, lat, lon, elev_m, mast_m)
                case[f"{body}_az"] = az
                case[f"{body}_el"] = el
                case[f"{body}_distance_km"] = dist
                case[f"{body}_radius_deg"] = ephemeris.angular_radius_deg(radius, dist)
            cases.append(case)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({
        "version": 1,
        "source": "python/scripts/build_audit_fixtures.py: ephemeris.interpolate_rows and view_from_rows on web/public/data/ephem.bin",
        "sun_radius_km": ephemeris.SUN_RADIUS_KM,
        "earth_radius_km": ephemeris.EARTH_RADIUS_KM,
        "cases": cases,
    }, indent=1), encoding="utf-8")
    print(f"wrote {len(cases)} cases to {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
