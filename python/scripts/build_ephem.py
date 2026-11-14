"""Build the Sun/Earth timetable, ``ephem.bin`` and ``ephem.json`` (Contract 1).

Role
    Builder. Asks SPICE where the Sun and the Earth appear from the Moon's
    centre at every hour from 16 Nov 2026 00:00 UTC to 1 Jan 2040 00:00 UTC
    (115,057 rows) and writes the result into a data folder. If the folder has
    a manifest, it is rewritten to include the timetable.

    The timetable depends only on NASA data, never on terrain, so the same
    real timetable goes into the mock folder and the real one.

Usage (from the repository root)
    python python/scripts/build_ephem.py web/public/data-mock
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lunar_engine import ephemeris, products, spice_env  # noqa: E402


def build(folder: Path) -> int:
    """Compute and write the timetable. Returns the number of rows."""
    times_ms = ephemeris.T0_MS + np.arange(ephemeris.ROW_COUNT, dtype=np.int64) * ephemeris.STEP_S * 1000
    with spice_env.loaded():
        rows = ephemeris.moon_centre_vectors(times_ms)
    products.write_ephem(folder, rows, ephemeris.T0_MS, ephemeris.STEP_S, ephemeris.ABERRATION)
    manifest_path = Path(folder) / "manifest.json"
    if manifest_path.exists():
        old = json.loads(manifest_path.read_text(encoding="utf-8"))
        products.write_manifest(folder, old["data_kind"], old["service_region"])
    return len(rows)


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point. Returns the process exit code."""
    parser = argparse.ArgumentParser(description="Build the Sun/Earth timetable.")
    parser.add_argument("folder", type=Path, help="data folder to write into")
    args = parser.parse_args(argv)
    count = build(args.folder)
    print(f"Wrote {count} rows to {args.folder / 'ephem.bin'}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
