"""Writing product files: JSON, the timetable and the manifest.

Role
    The shared file writers of the Builder, so that every product is written
    the same way whether it goes to ``web/public/data`` or to the mock folder
    (spec sections 4, 5 and 12).

Rules applied to every file written here
    * JSON has Unix line endings, so a file has the same size on every system
      (the manifest records sizes), and never contains NaN or Infinity, which
      a browser would refuse.
    * Binary files are little-endian.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from . import contracts


def write_json(path: Path, data, compact: bool = False) -> None:
    """Write a JSON file.

    Args:
        path: destination; parent folders are created.
        data: the document.
        compact: one line without spaces (for large number arrays) instead of
            indented text.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = (json.dumps(data, separators=(",", ":"), allow_nan=False) if compact
            else json.dumps(data, indent=2, allow_nan=False))
    path.write_text(text + "\n", encoding="utf-8", newline="\n")


def write_ephem(folder: Path, rows_km: np.ndarray, t0_ms: int, step_s: int,
                aberration: str) -> None:
    """Write the Sun/Earth timetable, ``ephem.bin`` and ``ephem.json`` (Contract 1).

    Args:
        folder: data folder.
        rows_km: shape ``(count, 6)``: Sun then Earth vector from the Moon's
            centre, km, ``MOON_ME``, one row per time step.
        t0_ms: UTC time of row 0, milliseconds since 1970.
        step_s: seconds between rows.
        aberration: the SPICE correction string used.

    Raises:
        ValueError: if what was written does not pass the contract check.
    """
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    rows = np.asarray(rows_km)
    if rows.ndim != 2 or rows.shape[1] != 6:
        raise ValueError("timetable rows must have six columns")
    rows.astype("<f4").tofile(folder / "ephem.bin")
    label = {
        "version": 1, "t0_ms": int(t0_ms), "step_s": step_s, "count": int(rows.shape[0]),
        "columns": list(contracts.EPHEM_COLUMNS), "units": "km", "frame": "MOON_ME",
        "origin": "MOON", "aberration": aberration,
    }
    write_json(folder / "ephem.json", label)
    problems = contracts.ephem_problems(label, folder / "ephem.bin")
    if problems:
        raise ValueError("timetable breaks its contract: " + "; ".join(problems))


def _contract_of(path: str) -> str:
    """Which contract a file in the data folder belongs to, from its path."""
    if path in ("ephem.bin", "ephem.json"):
        return "ephem"
    if path == "sites.json":
        return "sites"
    return {"skylines": "skyline", "terrain": "terrain", "shade": "shade"}[path.split("/")[0]]


def write_manifest(folder: Path, data_kind: str, service_region: dict,
                   built_ms: int | None = None) -> None:
    """Write ``manifest.json`` for whatever is in the folder (spec section 12).

    Call it last: it lists every file present with its size.

    Args:
        folder: data folder; must already contain ``sites.json``.
        data_kind: ``"mock"`` or ``"real"``.
        service_region: ``{"lat_min": ..., "lat_max": ...}``, degrees.
        built_ms: build time, UTC milliseconds since 1970 (default: now).
    """
    folder = Path(folder)
    sites = json.loads((folder / "sites.json").read_text(encoding="utf-8"))["sites"]
    files = sorted(p.relative_to(folder).as_posix() for p in folder.rglob("*")
                   if p.is_file() and p.name != "manifest.json")
    write_json(folder / "manifest.json", {
        "version": 1,
        "data_kind": data_kind,
        "built_ms": int(time.time() * 1000) if built_ms is None else int(built_ms),
        "service_region": service_region,
        "files": [{"path": path, "contract": _contract_of(path), "version": 1,
                   "bytes": (folder / path).stat().st_size} for path in files],
        "sites": [{"id": s["id"], "has_terrain": s["has_terrain"],
                   "has_shade_grid": s["has_shade_grid"]} for s in sites],
    })
