"""Build the mock data folder ``web/public/data-mock/``.

Role
    Gives the web side contract-exact files to develop against before the
    real products exist. Same file names, fields, units, order and binary
    layout as ``web/public/data/``; the values come from an invented
    landscape (:mod:`lunar_engine.mock_world`), not from NASA data.

How it works, in plain words
    Ten invented sites are placed on the mock landscape so that they differ
    the way real sites do (crater floors, rims, peaks, plains, near side, far
    side). For each one a skyline and a terrain patch are written; two also
    get a shade grid, so the web app meets both sites with and without one.
    The manifest is written last and marks the folder as ``"mock"``.

    If the folder already holds the timetable (``ephem.bin`` and
    ``ephem.json``, which are real and added by the timetable step), it is
    kept and listed.

Usage (from the repository root)
    python python/scripts/make_mock_data.py
"""

from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lunar_engine import contracts, mock_world  # noqa: E402

OUTPUT = contracts.REPO_DIR / "web" / "public" / "data-mock"

#: Service region of the mock (and the proposed real one): 80 S to the pole.
SERVICE_REGION = {"lat_min": -90.0, "lat_max": -80.0}

MAST_M = 2.0
SKYLINE_AZ_STEP_DEG = 0.1
TERRAIN_N, TERRAIN_SPACING_M = 121, 40.0        # 4.8 km square
SHADE_N, SHADE_SPACING_M = 25, 200.0            # the same 4.8 km square
SHADE_AZ_STEP_DEG = 5.0
SHADE_SCALE = 0.003                             # Int16 * 0.003 = degrees (range +/- 98)

#: (id, name, lat, lon, category, notes, extra info-card fields, has shade grid)
MOCK_SITES = [
    ("mock_crater_floor", "Mock crater floor", -89.55, 120.0, "psr",
     "Inside the deep mock crater. Walls about 20 degrees high all round: never lit.", {}, True),
    ("mock_crater_rim", "Mock crater rim", -89.245, 130.0, "high_illumination",
     "On the crest of the raised rim of the mock crater.",
     {"mission": "Mock mission A", "date_utc": "2028-09-01T00:00:00Z", "country": "Mockland"}, True),
    ("mock_peak", "Mock near-side peak", -86.02, 1.0, "high_illumination",
     "Top of the 5 km mock mountain facing the Earth.", {}, False),
    ("mock_peak_north_foot", "Mock plain north of the peak", -85.0, 0.0, "plain",
     "Earth-facing plain in front of the mock mountain.",
     {"mission": "Mock mission B", "country": "Mockland"}, False),
    ("mock_behind_peak", "Mock plain behind the peak", -87.0, 0.0, "plain",
     "South of the mock mountain, which stands between this site and the Earth.", {}, False),
    ("mock_ridge", "Mock ridge", -88.3, -120.0, "high_illumination",
     "Top of a 2.5 km mock peak near the pole.", {}, False),
    ("mock_second_crater", "Mock second crater floor", -87.25, -72.0, "psr",
     "Floor of the second mock crater.", {}, False),
    ("mock_far_highland", "Mock far-side highland", -84.5, 150.0, "plain",
     "Far-side facing: the Earth stays near or below the horizon.", {}, False),
    ("mock_east_plain", "Mock eastern plain", -85.5, 90.0, "plain",
     "Flat ground on the eastern limb.", {}, False),
    ("mock_near_pole", "Mock point beside the pole", -89.95, -30.0, "plain",
     "1.5 km from the pole: tests azimuths where every direction is nearly north.", {}, False),
]


def _write_json(path: Path, data, compact: bool = False) -> None:
    """Write JSON with Unix line endings (sizes must be the same on every system)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, separators=(",", ":")) if compact else json.dumps(data, indent=2)
    path.write_text(text + "\n", encoding="utf-8", newline="\n")


def build(output: Path = OUTPUT, built_ms: int | None = None, log=print) -> None:
    """Write the whole mock folder.

    Args:
        output: destination folder. Everything in it except the timetable is
            replaced.
        built_ms: build time for the manifest, UTC milliseconds since 1970
            (default: now).
        log: called with one progress line per site.
    """
    output = Path(output)
    for sub in ("skylines", "terrain", "shade"):
        shutil.rmtree(output / sub, ignore_errors=True)
    output.mkdir(parents=True, exist_ok=True)

    sites = []
    for sid, name, lat, lon, category, notes, extra, has_shade in MOCK_SITES:
        log(f"{sid} ...")
        record = mock_world.site_skyline(lat, lon, MAST_M, SKYLINE_AZ_STEP_DEG)
        _write_json(output / "skylines" / f"{sid}.json", record, compact=True)

        common = {"dem": [mock_world.MOCK_DEM_NAME], "resolution_m": mock_world.MOCK_RESOLUTION_M}
        patch = mock_world.terrain_patch(lat, lon, TERRAIN_N, TERRAIN_SPACING_M)
        (output / "terrain").mkdir(exist_ok=True)
        patch.astype("<f4").tofile(output / "terrain" / f"{sid}.bin")
        _write_json(output / "terrain" / f"{sid}.json", {
            "version": 1, "lat": lat, "lon": lon, "elev_m": record["elev_m"],
            "size_m": (TERRAIN_N - 1) * TERRAIN_SPACING_M, "n": TERRAIN_N,
            "spacing_m": TERRAIN_SPACING_M, **common})

        if has_shade:
            skylines, normals = mock_world.shade_grid(
                lat, lon, SHADE_N, SHADE_SPACING_M, SHADE_AZ_STEP_DEG, MAST_M)
            (output / "shade").mkdir(exist_ok=True)
            np.round(skylines / SHADE_SCALE).astype("<i2").tofile(output / "shade" / f"{sid}_skyline.bin")
            normals.astype("<f4").tofile(output / "shade" / f"{sid}_normal.bin")
            _write_json(output / "shade" / f"{sid}.json", {
                "version": 1, "center_lat": lat, "center_lon": lon,
                "size_m": (SHADE_N - 1) * SHADE_SPACING_M, "n": SHADE_N,
                "spacing_m": SHADE_SPACING_M, "az_step_deg": SHADE_AZ_STEP_DEG,
                "n_az": skylines.shape[2], "skyline_scale": SHADE_SCALE,
                "mast_m": MAST_M, **common})

        sites.append({"id": sid, "name": name, "lat": lat, "lon": lon, "category": category,
                      **extra, "notes": notes, "has_terrain": True, "has_shade_grid": has_shade})

    _write_json(output / "sites.json", {"version": 1, "sites": sites})

    def contract_of(path: str) -> str:
        if path.startswith("ephem."):
            return "ephem"
        return {"sites.json": "sites", "skylines": "skyline", "terrain": "terrain",
                "shade": "shade"}[path.split("/")[0]]

    files = sorted(p for p in output.rglob("*") if p.is_file() and p.name != "manifest.json")
    _write_json(output / "manifest.json", {
        "version": 1,
        "data_kind": "mock",
        "built_ms": int(time.time() * 1000) if built_ms is None else built_ms,
        "service_region": SERVICE_REGION,
        "files": [{"path": p.relative_to(output).as_posix(),
                   "contract": contract_of(p.relative_to(output).as_posix()),
                   "version": 1, "bytes": p.stat().st_size} for p in files],
        "sites": [{"id": s["id"], "has_terrain": s["has_terrain"],
                   "has_shade_grid": s["has_shade_grid"]} for s in sites],
    })


if __name__ == "__main__":
    build()
    found = contracts.data_folder_problems(OUTPUT, allow_missing_ephem=True)
    print("\n".join(found) if found else f"Mock data written to {OUTPUT} and valid.")
    sys.exit(1 if found else 0)
