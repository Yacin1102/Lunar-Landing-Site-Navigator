"""Check a data folder against the contracts.

Role
    Run over ``web/public/data`` or ``web/public/data-mock`` to confirm every
    file matches its contract: fields, units and ranges (JSON Schemas in
    ``docs/schemas/``), binary sizes against their labels, and the manifest
    against what is on disk. The checks themselves live in
    :mod:`lunar_engine.contracts`.

Usage (from the repository root)
    python python/scripts/validate_data.py web/public/data-mock
    python python/scripts/validate_data.py web/public/data-mock --allow-missing-ephem

Exit code 0 when the folder is valid, 1 otherwise.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lunar_engine import contracts  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point. Returns the process exit code."""
    parser = argparse.ArgumentParser(description="Check a data folder against the contracts.")
    parser.add_argument("folder", type=Path)
    parser.add_argument("--allow-missing-ephem", action="store_true",
                        help="accept a folder without the timetable")
    args = parser.parse_args(argv)
    if not args.folder.is_dir():
        print(f"{args.folder} is not a folder")
        return 1
    problems = contracts.data_folder_problems(args.folder, args.allow_missing_ephem)
    for problem in problems:
        print("PROBLEM", problem)
    files = sum(1 for p in args.folder.rglob("*") if p.is_file())
    print(f"{args.folder}: {files} files, {len(problems)} problem(s).")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
