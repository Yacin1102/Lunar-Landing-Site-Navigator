"""Print the ground around each curated site, from the real maps.

Role
    The cross-check of spec section 6: a small coordinate error near the pole
    can move a site from a sunlit ridge into a shadowed crater, so the map at
    each site must look like what the source describes. This prints, for
    every site in ``sites.json``, its height, the published height error, the
    local slope, and the highest (and, from 3 km, lowest) and median ground
    within 0.2, 1, 3 and 10 km relative to the site. The table in
    ``python/sites_sources.md`` is this output. The pass/fail checks are in
    ``tests/test_sites.py``.

Usage (from the repository root, with the full maps on disk)
    python python/scripts/check_sites.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lunar_engine import lola, sites  # noqa: E402

DEM_DIR = Path(__file__).resolve().parents[1] / "dem"


def main() -> int:
    """Command-line entry point. Returns the process exit code."""
    source = lola.open_lola(DEM_DIR, log=lambda message: None)
    print("| id | map | height m | error m | slope deg | 0.2 km max / median | 1 km max / median "
          "| 3 km max / min / median | 10 km max / min / median |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for site in sites.load_sites():
        t = sites.terrain_summary(source, site["lat"], site["lon"])
        d = t["discs"]
        print(f"| {site['id']} | {t['map'].split('.')[0]} | {t['height_m']:.1f} | {t['height_error_m']:.2f} "
              f"| {t['slope_deg']:.1f} "
              + "".join(f"| {d[r]['max_m']:+.0f} / {d[r]['median_m']:+.0f} " for r in (200.0, 1_000.0))
              + f"| {d[3_000.0]['max_m']:+.0f} / {d[3_000.0]['min_m']:+.0f} / {d[3_000.0]['median_m']:+.0f} "
              + f"| {d[10_000.0]['max_m']:+.0f} / {d[10_000.0]['min_m']:+.0f} / {d[10_000.0]['median_m']:+.0f} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
