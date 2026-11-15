"""Set the ``has_terrain`` and ``has_shade_grid`` flags in ``sites.json``.

Role
    The flags are set by Python, true only if that site's files exist (spec
    section 6). Run this after building terrain patches or shade grids. The
    work is done by :func:`lunar_engine.sites.update_flags`; an interrupted
    build (some of a site's files present, some missing) is reported and
    nothing is written.

Usage (from the repository root)
    python python/scripts/update_site_flags.py web/public/data

Exit code 0 on success, 1 if a build looks interrupted.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lunar_engine import sites  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point. Returns the process exit code."""
    parser = argparse.ArgumentParser(description="Set the site flags from the files present.")
    parser.add_argument("folder", type=Path)
    args = parser.parse_args(argv)
    try:
        changes = sites.update_flags(args.folder)
    except ValueError as error:
        print("PROBLEM", error)
        return 1
    for change in changes:
        print(change)
    print(f"{args.folder / 'sites.json'}: {len(changes)} flag(s) changed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
