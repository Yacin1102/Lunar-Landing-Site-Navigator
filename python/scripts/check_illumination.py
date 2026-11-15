"""Print how often each curated site sees the Sun and the Earth (the final proof).

Role
    Reads the built products in a data folder (the timetable and each site's
    skyline) and prints, for every site, the share of the timetable's hours
    in which the Sun and the Earth are certainly visible, certainly hidden,
    or uncertain (:mod:`lunar_engine.illumination`). The table in
    ``docs/ACCURACY.md`` is this output; the pass/fail checks are in
    ``tests/test_illumination.py``.

Usage (from the repository root)
    python python/scripts/check_illumination.py web/public/data
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lunar_engine import illumination, sites  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point. Returns the process exit code."""
    parser = argparse.ArgumentParser(description="Sun and Earth visibility per site.")
    parser.add_argument("folder", type=Path)
    args = parser.parse_args(argv)
    label = json.loads((args.folder / "ephem.json").read_text(encoding="utf-8"))
    rows = np.fromfile(args.folder / "ephem.bin", dtype="<f4").reshape(label["count"], 6).astype(float)
    print("| id | category | Sun certainly visible | Sun uncertain | Sun certainly hidden "
          "| Earth certainly visible | Earth uncertain | Earth certainly hidden |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for site in sites.load_sites(args.folder / "sites.json"):
        record = json.loads((args.folder / "skylines" / f"{site['id']}.json").read_text(encoding="utf-8"))
        sun, earth = illumination.sun_and_earth(rows, record)
        print(f"| {site['id']} | {site['category']} | {sun.visible:.1%} | {sun.uncertain:.1%} | {sun.hidden:.1%} "
              f"| {earth.visible:.1%} | {earth.uncertain:.1%} | {earth.hidden:.1%} |")
    print(f"Hours: {label['count']} (hourly, {label['t0_ms']} ms onward)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
