"""Fetch reference Sun and Earth directions from JPL Horizons.

Role
    Referee. JPL Horizons is NASA's own online ephemeris service and is
    independent of this project's code. This script asks it for the azimuth
    and elevation of the Sun and the Earth seen from several lunar surface
    sites at several moments, and saves the answers together with the exact
    queries in ``python/tests/data/horizons_altaz.json``.

    The tests compare the engine with that saved file, so they run without
    the internet. Horizons is used for validation only; nothing at run time
    depends on it (spec section 13).

What Horizons is asked
    Observer table, centre ``coord@301`` (a point on the Moon given as east
    longitude, latitude and height in km above the 1737.4 km sphere),
    quantity 4 (apparent azimuth and elevation, no atmosphere). Horizons
    states in its reply that it uses the Moon's ``MEAN_ME`` high-precision
    orientation, the frame this project uses.

Usage (from the repository root; needs the internet)
    python python/scripts/fetch_horizons.py
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import requests

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
OUTPUT = Path(__file__).resolve().parents[1] / "tests" / "data" / "horizons_altaz.json"

#: Julian date (UTC) of 1970-01-01 00:00.
UNIX_EPOCH_JD = 2440587.5

#: (latitude deg, east longitude deg, height km above the sphere)
SITES = [(-85.0, 40.0, 0.0), (-89.9, -120.0, 0.0), (-80.0, 180.0, 0.0),
         (-88.0, -90.0, 5.0), (-86.5, 0.0, -4.0)]

#: Julian dates (UTC), chosen so each is a whole number of milliseconds:
#: 17 Nov 2026 to 1 Jan 2040 (the last timetable row).
JULIAN_DATES = [2461361.5, 2461500.25, 2462000.25, 2463000.75, 2464500.5, 2466154.5]

BODIES = {"SUN": "10", "EARTH": "399"}


def query(body_id: str, lat: float, lon: float, alt_km: float) -> tuple[dict, str]:
    """Run one Horizons query. Returns ``(parameters sent, reply text)``."""
    params = {
        "format": "text", "COMMAND": f"'{body_id}'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'", "CENTER": "'coord@301'", "COORD_TYPE": "'GEODETIC'",
        "SITE_COORD": f"'{lon},{lat},{alt_km}'",
        "TLIST": ",".join(f"'{jd}'" for jd in JULIAN_DATES),
        "QUANTITIES": "'4'", "ANG_FORMAT": "'DEG'", "CSV_FORMAT": "'YES'", "EXTRA_PREC": "'YES'",
    }
    reply = requests.get(API, params=params, timeout=120)
    reply.raise_for_status()
    return params, reply.text


def parse(text: str) -> tuple[list[tuple[float, float]], str]:
    """Pull the (azimuth, elevation) rows and the frame line out of a reply."""
    if "$$SOE" not in text:
        raise ValueError("Horizons returned no table:\n" + text[:2000])
    table = text.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()
    rows = []
    for line in table:
        fields = [f.strip() for f in line.split(",")]
        rows.append((float(fields[3]), float(fields[4])))
    frame = next(line.strip() for line in text.splitlines() if line.startswith("Center pole/equ"))
    return rows, frame


def main() -> int:
    """Fetch every site and body and write the reference file."""
    results = []
    for lat, lon, alt_km in SITES:
        for body, body_id in BODIES.items():
            params, text = query(body_id, lat, lon, alt_km)
            rows, frame = parse(text)
            if len(rows) != len(JULIAN_DATES):
                raise ValueError(f"expected {len(JULIAN_DATES)} rows, got {len(rows)}")
            results.append({
                "body": body, "lat": lat, "lon": lon, "elev_m": alt_km * 1000.0,
                "horizons_frame_line": frame, "query": params,
                "rows": [{"jd_utc": jd, "t_ms": int(round((jd - UNIX_EPOCH_JD) * 86_400_000)),
                          "az_deg": az, "el_deg": el}
                         for jd, (az, el) in zip(JULIAN_DATES, rows)],
            })
            print(f"{body:5s} from lat {lat}, lon {lon}, {alt_km} km: {len(rows)} rows")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({
        "version": 1,
        "source": "JPL Horizons API, " + API,
        "fetched_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": "Apparent azimuth and elevation (quantity 4), airless, observer on the lunar surface.",
        "results": results,
    }, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"Wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
