"""Build the real data folder: skylines, terrain patches, shade grids, timetable, manifest.

Role
    Builder. Writes into ``web/public/data/`` (next to the hand-written
    ``sites.json``):

    1. ``skylines/{id}.json`` for every site (Contract 3), with the error
       bound, by :func:`lunar_engine.records.skyline_record`, the same
       function the live API uses.
    2. ``terrain/{id}.bin`` + ``.json`` (Contract 4).
    3. ``shade/{id}.json``, ``_skyline.bin``, ``_normal.bin`` (Contract 5).
    4. ``ephem.bin`` + ``ephem.json`` (Contract 1), from SPICE.
    5. The ``has_terrain`` / ``has_shade_grid`` flags, from the files present.
    6. ``manifest.json``, marked ``data_kind: "real"``, written last.

    The folder is then checked against every contract.

Resuming and running in parallel
    A finished file is never rebuilt. Shade grids are built one row of cells
    at a time, and each finished row is kept in ``python/dem/cache/shade_rows/``
    (never committed), so an interrupted build loses at most the rows in
    progress. Before any worker process starts, one site's skyline is built
    in the main process, so every table the workers need already exists on
    disk and no two processes ever build the same table.

Usage (from the repository root, with all data on disk)
    python python/scripts/build_products.py web/public/data [--workers 14]

Exit code 0 when the folder is valid, 1 otherwise.
"""

from __future__ import annotations

import argparse
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lunar_engine import contracts, lola, patches, products, records, sites  # noqa: E402

DEM_DIR = Path(__file__).resolve().parents[1] / "dem"
ROWS_DIR = lola.DEFAULT_CACHE / "shade_rows"
#: Curated skylines and shade cells: eye 2 m above the ground (the API default).
MAST_M = 2.0
#: Curated skylines: 0.1 degree wedges.
AZ_STEP_DEG = 0.1

_source = None


def _open():
    global _source
    if _source is None:
        _source = lola.open_lola(DEM_DIR, log=lambda message: None)
    return _source


def _skyline(folder: str, site: dict) -> str:
    """Compute and write one site's skyline record."""
    started = time.time()
    record = records.skyline_record(_open(), site["lat"], site["lon"], MAST_M, AZ_STEP_DEG)
    records.write_skyline(Path(folder), site["id"], record)
    return (f"skyline {site['id']}: {time.time() - started:.0f} s, {min(record['skyline_deg']):.2f} "
            f"to {max(record['skyline_deg']):.2f} deg, error up to {max(record['skyline_err_deg']):.3f} deg, "
            f"reach {record['max_reach_km']:.0f} km")


def _shade_row(site: dict, row: int) -> str:
    """Compute one row of a site's shade grid and keep it on disk (skipped if already there)."""
    started = time.time()
    path = ROWS_DIR / site["id"] / f"row_{row:02d}.npy"
    if path.exists():
        return f"shade {site['id']} row {row}: already built"
    source = _open()
    frame = patches.SiteFrame(source, site["lat"], site["lon"])
    points = frame.cell_points()[row]
    values = np.stack([patches.cell_skyline(source, frame, p, MAST_M) for p in points])
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.stem + ".partial.npy")
    np.save(tmp, values)
    tmp.replace(path)
    return f"shade {site['id']} row {row}: {time.time() - started:.0f} s"


def _shade_params(site: dict) -> dict:
    """Everything a site's saved shade rows depend on; rows made otherwise are not reused."""
    return {"method": patches.SHADE_METHOD_VERSION, "lat": site["lat"], "lon": site["lon"], "mast_m": MAST_M,
            "n": patches.SHADE_N, "spacing_m": patches.SHADE_SPACING_M, "az_step_deg": patches.SHADE_AZ_STEP_DEG,
            "tolerance_deg": patches.SHADE_TOLERANCE_DEG, "maps": [lola._source_stamp(DEM_DIR / h) for h, _ in lola.PRODUCTS]}


def _check_shade_rows(folder: Path, site: dict) -> None:
    """Delete a site's saved rows and shade files if they were made differently (found by review)."""
    import json
    import shutil

    rows_dir = ROWS_DIR / site["id"]
    params_path = rows_dir / "params.json"
    params = _shade_params(site)
    if rows_dir.exists() and (not params_path.exists() or json.loads(params_path.read_text()) != params):
        shutil.rmtree(rows_dir)
        for name in (f"{site['id']}.json", f"{site['id']}_skyline.bin", f"{site['id']}_normal.bin"):
            (folder / "shade" / name).unlink(missing_ok=True)
        print(f"shade {site['id']}: saved rows were made differently, rebuilt from scratch", flush=True)
    rows_dir.mkdir(parents=True, exist_ok=True)
    params_path.write_text(json.dumps(params))


def _write_terrain(folder: Path, site: dict) -> None:
    source = _open()
    frame = patches.SiteFrame(source, site["lat"], site["lon"])
    heights = frame.terrain_patch()
    (folder / "terrain").mkdir(exist_ok=True)
    heights.astype("<f4").tofile(folder / "terrain" / f"{site['id']}.bin")
    products.write_json(folder / "terrain" / f"{site['id']}.json", {
        "version": 1, "lat": site["lat"], "lon": site["lon"], "elev_m": round(frame.elev_m, 3),
        "size_m": (patches.TERRAIN_N - 1) * patches.TERRAIN_SPACING_M, "n": patches.TERRAIN_N,
        "spacing_m": patches.TERRAIN_SPACING_M, "dem": [frame.grid.name],
        "resolution_m": frame.grid.spec.pixel_m})


def _write_shade(folder: Path, site: dict) -> None:
    source = _open()
    frame = patches.SiteFrame(source, site["lat"], site["lon"])
    rows = [np.load(ROWS_DIR / site["id"] / f"row_{i:02d}.npy") for i in range(patches.SHADE_N)]
    skylines = np.stack(rows)                                     # (n, n, n_az), degrees
    (folder / "shade").mkdir(exist_ok=True)
    np.round(skylines / patches.SHADE_SCALE).astype("<i2").tofile(folder / "shade" / f"{site['id']}_skyline.bin")
    frame.normals().astype("<f4").tofile(folder / "shade" / f"{site['id']}_normal.bin")
    products.write_json(folder / "shade" / f"{site['id']}.json", {
        "version": 1, "center_lat": site["lat"], "center_lon": site["lon"],
        "size_m": (patches.SHADE_N - 1) * patches.SHADE_SPACING_M, "n": patches.SHADE_N,
        "spacing_m": patches.SHADE_SPACING_M, "az_step_deg": patches.SHADE_AZ_STEP_DEG,
        "n_az": skylines.shape[2], "skyline_scale": patches.SHADE_SCALE, "mast_m": MAST_M,
        "dem": source.names, "resolution_m": frame.grid.spec.pixel_m})


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point. Returns the process exit code."""
    parser = argparse.ArgumentParser(description="Build the real data folder.")
    parser.add_argument("folder", type=Path)
    parser.add_argument("--workers", type=int, default=14)
    parser.add_argument("--skip-shade", action="store_true", help="build everything but the shade grids")
    parser.add_argument("--shade-rows-only", action="store_true",
                        help="only compute shade rows (they need no error-bound tables), last site first")
    args = parser.parse_args(argv)
    folder = args.folder
    all_sites = sites.load_sites(folder / "sites.json")
    if args.shade_rows_only:
        for site in all_sites:
            _check_shade_rows(folder, site)
        rows = [(s, i) for s in reversed(all_sites) for i in reversed(range(patches.SHADE_N))]
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            for line in pool.map(_shade_row, *zip(*rows)):
                print(line, flush=True)
        return 0

    if not args.skip_shade:
        for site in all_sites:
            _check_shade_rows(folder, site)
    todo = [s for s in all_sites if not (folder / "skylines" / f"{s['id']}.json").exists()]
    if todo:                       # the first one here, so every table is on disk before the workers start
        print(_skyline(str(folder), todo.pop(0)), flush=True)
    else:
        _open().grids[0].pyramid(_open().unknown_height_m)
    rows = [] if args.skip_shade else [
        (s, i) for s in all_sites for i in range(patches.SHADE_N)
        if not (folder / "shade" / f"{s['id']}.json").exists()
        and not (ROWS_DIR / s["id"] / f"row_{i:02d}.npy").exists()]
    print(f"{len(todo)} skyline(s) and {len(rows)} shade row(s) to build with {args.workers} workers", flush=True)
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        jobs = [pool.submit(_skyline, str(folder), s) for s in todo]
        jobs += [pool.submit(_shade_row, s, i) for s, i in rows]
        for job in jobs:
            print(job.result(), flush=True)

    for site in all_sites:
        if not (folder / "terrain" / f"{site['id']}.json").exists():
            _write_terrain(folder, site)
            print(f"terrain {site['id']}: written", flush=True)
        if not args.skip_shade and not (folder / "shade" / f"{site['id']}.json").exists():
            _write_shade(folder, site)
            print(f"shade {site['id']}: written", flush=True)

    import build_ephem
    print(f"timetable: {build_ephem.build(folder)} rows")
    for change in sites.update_flags(folder):
        print(change)
    products.write_manifest(folder, "real", contracts.SERVICE_REGION)
    problems = contracts.data_folder_problems(folder)
    for problem in problems:
        print("PROBLEM", problem)
    print(f"{folder}: {len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
