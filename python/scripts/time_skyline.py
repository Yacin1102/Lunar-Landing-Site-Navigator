"""Time one skyline on the real LOLA maps (a measurement, not a test).

Role
    Reproduces the speed figures in ``docs/ACCURACY.md``: one skyline run
    (not the three runs of the error bound) at a point 0.2 degrees from the
    pole, at 1 degree and at 0.1 degree wedges. Times depend on the machine
    and on whether the maps are already in the operating system's memory.

Usage (from the repository root, after build_dem_cache.py)
    python python/scripts/time_skyline.py [lat lon]
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lunar_engine import lola  # noqa: E402
from lunar_engine.skyline import compute_skyline  # noqa: E402


def main(argv: list[str]) -> int:
    lat, lon = (float(argv[0]), float(argv[1])) if len(argv) == 2 else (-89.8, 0.0)
    source = lola.open_lola(Path(__file__).resolve().parents[1] / "dem", log=lambda m: None)
    print(f"point {lat}, {lon}: ground {source.height(lat, lon):.1f} m, pixel {source.resolution_at(lat, lon):g} m")
    for step in (1.0, 0.1):
        started = time.time()
        result = compute_skyline(source, lat, lon, mast_m=2.0, az_step_deg=step)
        half = (result.upper_deg - result.floor_deg) / 2
        print(f"wedges {step:g} deg: {time.time() - started:.0f} s; skyline {result.skyline_deg.min():.3f} "
              f"to {result.skyline_deg.max():.3f} deg; interval half-width mean {half.mean():.4f}, "
              f"largest {half.max():.4f} deg; search reached {result.max_reach_km:.1f} km")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
