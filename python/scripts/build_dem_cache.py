"""Prepare the LOLA maps for use: decompress them and build their tables.

Role
    The first use of each map decompresses it into ``python/dem/cache/`` and
    builds its highest-terrain tables (see :mod:`lunar_engine.lola`). For the
    four full-resolution maps that is about 38 GB of decompression and takes
    a while, so this script does it up front, with progress. Running it again
    does nothing for maps whose caches are up to date.

Usage (from the repository root)
    python python/scripts/build_dem_cache.py            the four full-resolution maps
    python python/scripts/build_dem_cache.py --coarse   the two coarse maps
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lunar_engine import lola  # noqa: E402
from lunar_engine.skyline import compute_skyline  # noqa: F401,E402  (checks the engine imports)

DEM_DIR = Path(__file__).resolve().parents[1] / "dem"


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point."""
    parser = argparse.ArgumentParser(description="Prepare the LOLA maps.")
    parser.add_argument("--coarse", action="store_true")
    args = parser.parse_args(argv)
    products = lola.COARSE_PRODUCTS if args.coarse else lola.PRODUCTS
    started = time.time()

    def log(message: str) -> None:
        print(f"[{time.time() - started:7.0f} s] {message}", flush=True)

    for heights, errors in products:
        log(f"{heights}: opening")
        grid = lola.LolaGrid(DEM_DIR / heights, DEM_DIR / errors, cache_root=lola.DEFAULT_CACHE, log=log)
        log(f"{heights}: trusted disc {grid.disc()}")
        grid.pyramid(11_000.0)
        log(f"{heights}: top height {grid._top_height():.1f} m; highest-terrain table ready")
    log("all maps ready")
    return 0


if __name__ == "__main__":
    sys.exit(main())
