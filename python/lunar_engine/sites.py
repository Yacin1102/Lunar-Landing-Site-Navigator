"""The curated site list (Contract 2): checking it, its file flags, and its terrain.

Role
    ``web/public/data/sites.json`` is the only place site coordinates exist
    (spec section 6). It is written by hand from the sources recorded in
    ``python/sites_sources.md``. This module checks it, keeps its
    ``has_terrain`` and ``has_shade_grid`` flags in step with the files on
    disk, and measures the ground around each site so that tests can confirm
    that the map agrees with what the source describes (a ridge crest, a rim,
    a plateau, a crater floor).

How the terrain is described, in plain words
    Around a site the map is read in discs of a few radii. For each disc, the
    highest, lowest and middle (median) ground are given relative to the
    site's own height. A ridge crest or summit is near the highest ground in
    its disc and well above the middle; a crater floor is near the lowest
    ground and far below the rim. The local slope is measured across two
    pixels on each side.

Units: degrees for latitude, longitude and slope; metres for heights and
distances.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .contracts import REPO_DIR, SERVICE_REGION, schema_problems
from .elevation import ElevationSource, to_xy

#: The site list the web app reads.
SITES_PATH = REPO_DIR / "web" / "public" / "data" / "sites.json"

#: The categories used, with their meaning (spec section 6 asks for the set
#: to be documented; the web app groups by whatever values appear).
CATEGORIES = {
    "high_illumination": "Ridge crests, rims and peaks in areas published as among the most often sunlit.",
    "landing_site": "Where a spacecraft has landed.",
    "psr": "Crater floors inside published permanently shadowed regions (PSRs).",
}


def site_list_problems(site_list: dict, service_region: dict = SERVICE_REGION) -> list[str]:
    """Check a site list beyond its schema.

    Checks the schema (Contract 2), that ids are unique, that every site lies
    in the service region, and that every category is one of
    :data:`CATEGORIES`.

    Returns:
        One sentence per problem; an empty list means the list is correct.
    """
    problems = schema_problems(site_list, "sites")
    if problems:
        return problems
    ids = [site["id"] for site in site_list["sites"]]
    for sid in sorted({i for i in ids if ids.count(i) > 1}):
        problems.append(f"site id {sid} is used more than once")
    for site in site_list["sites"]:
        if not service_region["lat_min"] <= site["lat"] <= service_region["lat_max"]:
            problems.append(f"{site['id']}: latitude {site['lat']} is outside the service region")
        if site["category"] not in CATEGORIES:
            problems.append(f"{site['id']}: category {site['category']!r} is not documented")
    return problems


def load_sites(path: Path = SITES_PATH) -> list[dict]:
    """The sites of a site list, after checking it.

    Raises:
        ValueError: if :func:`site_list_problems` finds anything wrong.
    """
    site_list = json.loads(Path(path).read_text(encoding="utf-8"))
    problems = site_list_problems(site_list)
    if problems:
        raise ValueError(f"{path}: " + "; ".join(problems))
    return site_list["sites"]


def product_files(folder: Path, site_id: str) -> dict[str, list[Path]]:
    """The files each flag stands for: ``{"has_terrain": [...], "has_shade_grid": [...]}``."""
    folder = Path(folder)
    return {
        "has_terrain": [folder / "terrain" / f"{site_id}.json", folder / "terrain" / f"{site_id}.bin"],
        "has_shade_grid": [folder / "shade" / f"{site_id}.json", folder / "shade" / f"{site_id}_skyline.bin",
                           folder / "shade" / f"{site_id}_normal.bin"],
    }


def update_flags(folder: Path) -> list[str]:
    """Set each site's ``has_terrain`` and ``has_shade_grid`` from the files present.

    A flag becomes true only when all of its files exist (spec section 6).
    ``sites.json`` in ``folder`` is rewritten only if a flag changed; field
    order and everything else are kept.

    Returns:
        One sentence per flag changed.

    Raises:
        ValueError: if only some of a flag's files exist, which means a build
            was interrupted. Nothing is written then.
    """
    path = Path(folder) / "sites.json"
    site_list = json.loads(path.read_text(encoding="utf-8"))
    changes = []
    for site in site_list["sites"]:
        for flag, files in product_files(folder, site["id"]).items():
            present = [f.exists() for f in files]
            if any(present) and not all(present):
                missing = [f.name for f, p in zip(files, present) if not p]
                raise ValueError(f"{site['id']}: some {flag} files are missing ({', '.join(missing)})")
            if site[flag] != all(present):
                site[flag] = all(present)
                changes.append(f"{site['id']}: {flag} set to {str(all(present)).lower()}")
    if changes:
        path.write_text(json.dumps(site_list, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return changes


def terrain_summary(source: ElevationSource, lat: float, lon: float,
                    radii_m=(200.0, 1_000.0, 3_000.0, 10_000.0), grid=None) -> dict:
    """Describe the ground around a point.

    Args:
        source: the terrain.
        lat, lon: the point, degrees.
        radii_m: radii of the discs examined, metres.
        grid: the map whose pixels are examined; by default the finest map
            at the point. A coarser one keeps wide discs small in memory.
            The point's own height always comes from ``source``.

    Returns:
        ``{"height_m", "height_error_m", "map", "slope_deg", "discs"}``, where
        ``discs`` maps each radius to ``{"max_m", "min_m", "median_m"}``: the
        highest, lowest and median pixel heights within that distance on the
        map, relative to the point's own height (metres; positive is above).
        Pixels without data are ignored.
    """
    grid = grid or source.grid_at(lat, lon)
    spec = grid.spec
    x, y = (float(v) for v in to_xy(lat, lon))
    height = source.height(lat, lon)
    col, row = int(round(float(spec.col_of_x(x)))), int(round(float(spec.row_of_y(y))))
    discs = {}
    for radius in radii_m:
        n = int(radius // spec.pixel_m)
        window = np.asarray(grid.read(max(0, row - n), row + n + 1, max(0, col - n), col + n + 1), float)
        rows, cols = np.indices(window.shape)
        rows += max(0, row - n)
        cols += max(0, col - n)
        inside = np.hypot(spec.x_of_col(cols) - x, spec.y_of_row(rows) - y) <= radius
        values = window[inside & np.isfinite(window)]
        if values.size == 0:
            raise ValueError(f"no map data within {radius} m of latitude {lat}, longitude {lon}")
        discs[radius] ={"max_m": float(values.max() - height), "min_m": float(values.min() - height),
                         "median_m": float(np.median(values) - height)}
    step = 2.0 * spec.pixel_m
    east = (grid.height_xy(x + step, y)[0] - grid.height_xy(x - step, y)[0]) / (2 * step)
    north = (grid.height_xy(x, y + step)[0] - grid.height_xy(x, y - step)[0]) / (2 * step)
    return {"height_m": height, "height_error_m": source.height_error(lat, lon), "map": grid.name,
            "slope_deg": float(np.degrees(np.arctan(np.hypot(east, north)))), "discs": discs}
