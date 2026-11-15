"""Checks that files and API responses match the data contracts.

Role
    The single place that knows what a correct product looks like (spec
    sections 4 to 12). The builders use it before writing, the tests use it on
    everything that is written, and ``scripts/validate_data.py`` runs it over a
    whole data folder.

How it works, in plain words
    Each JSON document is checked against its JSON Schema in ``docs/schemas/``
    (field names, types, allowed ranges, no extra fields). The schemas cannot
    express everything, so further checks are done here in code: array
    lengths that must equal ``360 / az_step_deg``, binary file sizes that must
    equal what the label promises, the centre of a terrain patch being 0,
    surface normals having length 1, and the manifest listing exactly the
    files that exist.

Every check returns a list of problems as plain sentences. An empty list
means the thing is correct.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

import numpy as np
from jsonschema import Draft202012Validator

REPO_DIR = Path(__file__).resolve().parents[2]
SCHEMA_DIR = REPO_DIR / "docs" / "schemas"

#: Schema names, in the order they are documented and turned into types.
SCHEMA_NAMES = ("ephem", "sites", "skyline", "terrain", "shade", "manifest",
                "altaz", "events")

#: Order and names of the six values in each timetable row (Contract 1).
EPHEM_COLUMNS = ("sun_x", "sun_y", "sun_z", "earth_x", "earth_y", "earth_z")

#: The timetable must reach this time: 1 Jan 2040 00:00 UTC, milliseconds since 1970.
EPHEM_END_MS = 2_208_988_800_000

#: The service region of the real data: 80 S to the pole (decision of
#: 2026-11-15, docs/PROGRESS.md). Degrees.
SERVICE_REGION = {"lat_min": -90.0, "lat_max": -80.0}


@lru_cache(maxsize=None)
def _validator(name: str) -> Draft202012Validator:
    schema = json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def schema_problems(document, name: str) -> list[str]:
    """Check a parsed JSON document against one of the schemas.

    Args:
        document: the parsed JSON (dict or list).
        name: schema name, one of :data:`SCHEMA_NAMES`.

    Returns:
        One sentence per violation, each starting with where it is.
    """
    problems = [f"{where}: not a finite number" for where in _non_finite(document)]
    for error in sorted(_validator(name).iter_errors(document), key=lambda e: str(list(e.path))):
        where = "/".join(str(part) for part in error.path) or "(top level)"
        message = error.message
        if len(message) > 200:      # the message quotes the whole offending value
            message = f"does not satisfy {error.validator}: {error.validator_value!r}"[:200]
        problems.append(f"{where}: {message}")
    return problems


def _non_finite(node, where: str = "") -> list[str]:
    """Paths of every NaN or infinite number in a parsed document.

    Python reads and writes ``NaN`` and ``Infinity`` in JSON, but they are not
    valid JSON: a browser refuses the whole file. They must never appear.
    """
    if isinstance(node, float) and not np.isfinite(node):
        return [where or "(top level)"]
    if isinstance(node, dict):
        return [p for key, value in node.items() for p in _non_finite(value, f"{where}/{key}".strip("/"))]
    if isinstance(node, list):
        return [p for i, value in enumerate(node) for p in _non_finite(value, f"{where}/{i}".strip("/"))]
    return []


def az_count(az_step_deg: float) -> int | None:
    """Number of azimuth entries for a step, or ``None`` if it does not divide 360.

    >>> az_count(0.1), az_count(5.0), az_count(0.7)
    (3600, 72, None)
    """
    count = 360.0 / az_step_deg
    return int(round(count)) if abs(count - round(count)) < 1e-9 else None


def skyline_problems(record) -> list[str]:
    """Check a skyline record (Contract 3), as written to a file.

    Beyond the schema: both arrays must have exactly ``360 / az_step_deg``
    entries, and that count must be a whole number.
    """
    problems = schema_problems(record, "skyline")
    if problems:
        return problems
    count = az_count(record["az_step_deg"])
    if count is None:
        return [f"az_step_deg {record['az_step_deg']} does not divide 360"]
    for field in ("skyline_deg", "skyline_err_deg"):
        if len(record[field]) != count:
            problems.append(f"{field} has {len(record[field])} entries, expected {count}")
    return problems


def _patch_label_problems(label: dict) -> list[str]:
    """Checks shared by terrain and shade labels: odd n, size = (n-1) * spacing."""
    problems = []
    if label["n"] % 2 == 0:
        problems.append(f"n = {label['n']} is even; there is no centre sample")
    expected = (label["n"] - 1) * label["spacing_m"]
    if abs(label["size_m"] - expected) > 1e-6 * expected:
        problems.append(f"size_m {label['size_m']} is not (n - 1) * spacing_m = {expected}")
    return problems


def terrain_problems(label, bin_path: Path) -> list[str]:
    """Check a terrain patch (Contract 4): label and binary file together.

    The binary must hold ``n * n`` little-endian Float32 values, all finite,
    with the centre value exactly 0.
    """
    problems = schema_problems(label, "terrain")
    if problems:
        return problems
    problems = _patch_label_problems(label)
    n = label["n"]
    size = Path(bin_path).stat().st_size
    if size != n * n * 4:
        return problems + [f"{Path(bin_path).name} is {size} bytes, expected n*n*4 = {n * n * 4}"]
    heights = np.fromfile(bin_path, dtype="<f4").reshape(n, n)
    if not np.all(np.isfinite(heights)):
        problems.append("terrain contains values that are not finite numbers")
    if heights[n // 2, n // 2] != 0.0:
        problems.append(f"centre value is {heights[n // 2, n // 2]}, expected 0")
    return problems


def shade_problems(label, skyline_bin: Path, normal_bin: Path) -> list[str]:
    """Check a shade grid (Contract 5): label and both binary files.

    ``_skyline.bin`` must hold ``n * n * n_az`` little-endian Int16 values
    that scale to angles within -90 to 90 degrees; ``_normal.bin`` must hold
    ``n * n * 3`` little-endian Float32 values forming unit vectors that
    point upward.
    """
    problems = schema_problems(label, "shade")
    if problems:
        return problems
    problems = _patch_label_problems(label)
    n, n_az = label["n"], label["n_az"]
    if az_count(label["az_step_deg"]) != n_az:
        problems.append(f"n_az {n_az} is not 360 / az_step_deg ({label['az_step_deg']})")
    size = Path(skyline_bin).stat().st_size
    if size != n * n * n_az * 2:
        problems.append(f"{Path(skyline_bin).name} is {size} bytes, expected n*n*n_az*2 = {n * n * n_az * 2}")
    else:
        degrees = np.fromfile(skyline_bin, dtype="<i2") * label["skyline_scale"]
        if degrees.min() < -90 or degrees.max() > 90:
            problems.append("shade skyline angles fall outside -90 to 90 degrees")
    size = Path(normal_bin).stat().st_size
    if size != n * n * 3 * 4:
        problems.append(f"{Path(normal_bin).name} is {size} bytes, expected n*n*3*4 = {n * n * 12}")
    else:
        normals = np.fromfile(normal_bin, dtype="<f4").reshape(n, n, 3)
        if not np.allclose(np.linalg.norm(normals, axis=-1), 1.0, atol=1e-5):
            problems.append("surface normals are not unit vectors")
        if normals[..., 2].min() <= 0:
            problems.append("a surface normal points downward")
    return problems


def ephem_problems(label, bin_path: Path) -> list[str]:
    """Check the timetable (Contract 1): label and binary file together.

    The binary must hold ``count`` rows of six little-endian Float32 values,
    all finite. Sanity: the Sun about one astronomical unit away, the Earth
    at lunar distance. The last row must be at or after 1 Jan 2040 00:00 UTC.
    """
    problems = schema_problems(label, "ephem")
    if problems:
        return problems
    last_ms = label["t0_ms"] + (label["count"] - 1) * label["step_s"] * 1000
    if last_ms < EPHEM_END_MS:
        problems.append(f"timetable ends at {last_ms:.0f} ms, before 1 Jan 2040 ({EPHEM_END_MS})")
    size = Path(bin_path).stat().st_size
    if size != label["count"] * 24:
        return problems + [f"ephem.bin is {size} bytes, expected count*6*4 = {label['count'] * 24}"]
    rows = np.fromfile(bin_path, dtype="<f4").reshape(-1, 6)
    if not np.all(np.isfinite(rows)):
        return problems + ["ephem.bin contains values that are not finite numbers"]
    sun_km = np.linalg.norm(rows[:, :3], axis=1)
    earth_km = np.linalg.norm(rows[:, 3:], axis=1)
    if sun_km.min() < 1.45e8 or sun_km.max() > 1.55e8:
        problems.append("Sun distance is outside 145 to 155 million km")
    if earth_km.min() < 3.5e5 or earth_km.max() > 4.1e5:
        problems.append("Earth distance is outside 350,000 to 410,000 km")
    return problems


def _load(path: Path, problems: list[str]):
    """Parse a JSON file, recording a problem instead of raising."""
    def refuse(token):
        raise ValueError(f"{token} is not valid JSON; a browser would reject the file")

    try:
        return json.loads(Path(path).read_text(encoding="utf-8"), parse_constant=refuse)
    except FileNotFoundError:
        problems.append(f"{path.name}: file is missing")
    except ValueError as error:
        problems.append(f"{path.name}: not valid JSON ({error})")
    return None


def data_folder_problems(folder: Path, allow_missing_ephem: bool = False) -> list[str]:
    """Check a whole data folder (``web/public/data`` or ``data-mock``).

    Checks every file against its contract, that each site has the files its
    flags promise and no others, that every site lies in the service region,
    and that the manifest lists exactly the files present with their sizes.

    Args:
        folder: the data folder.
        allow_missing_ephem: accept a folder without the timetable (used only
            while the mock data is ahead of the timetable).

    Returns:
        One sentence per problem, prefixed with the file it concerns.
    """
    folder = Path(folder)
    problems: list[str] = []

    def add(prefix: str, found: list[str]) -> None:
        problems.extend(f"{prefix}: {text}" for text in found)

    manifest = _load(folder / "manifest.json", problems)
    if manifest is not None:
        found = schema_problems(manifest, "manifest")
        if not found and manifest["service_region"]["lat_min"] > manifest["service_region"]["lat_max"]:
            found = ["service_region: lat_min is north of lat_max"]
        add("manifest.json", found)
        if found:
            manifest = None

    ephem_label = folder / "ephem.json"
    if ephem_label.exists() or not allow_missing_ephem:
        label = _load(ephem_label, problems)
        if label is not None:
            if (folder / "ephem.bin").exists():
                add("ephem", ephem_problems(label, folder / "ephem.bin"))
            else:
                problems.append("ephem.bin: file is missing")

    site_list = _load(folder / "sites.json", problems)
    sites = []
    if site_list is not None:
        found = schema_problems(site_list, "sites")
        add("sites.json", found)
        if not found:
            sites = site_list["sites"]
    ids = [site["id"] for site in sites]
    if len(set(ids)) != len(ids):
        problems.append("sites.json: site ids are not unique")

    for site in sites:
        sid = site["id"]
        if manifest is not None:
            region = manifest["service_region"]
            if not region["lat_min"] <= site["lat"] <= region["lat_max"]:
                problems.append(f"sites.json: {sid} at latitude {site['lat']} is outside the service region")

        record = _load(folder / "skylines" / f"{sid}.json", problems)
        if record is not None:
            found = skyline_problems(record)
            if not found and (record["lat"], record["lon"]) != (site["lat"], site["lon"]):
                found = ["lat/lon differ from sites.json"]
            add(f"skylines/{sid}.json", found)

        terrain_files = [folder / "terrain" / f"{sid}.json", folder / "terrain" / f"{sid}.bin"]
        shade_files = [folder / "shade" / f"{sid}.json", folder / "shade" / f"{sid}_skyline.bin",
                       folder / "shade" / f"{sid}_normal.bin"]
        for flag, files, kind in ((site["has_terrain"], terrain_files, "terrain"),
                                  (site["has_shade_grid"], shade_files, "shade")):
            present = [f.exists() for f in files]
            if flag and not all(present):
                problems.append(f"{kind}/{sid}: flag is true but a file is missing")
                continue
            if not flag:
                if any(present):
                    problems.append(f"{kind}/{sid}: flag is false but files exist")
                continue
            label = _load(files[0], problems)
            if label is None:
                continue
            if kind == "terrain":
                found = terrain_problems(label, files[1])
                position = (label.get("lat"), label.get("lon"))
            else:
                found = shade_problems(label, files[1], files[2])
                position = (label.get("center_lat"), label.get("center_lon"))
            if not found and position != (site["lat"], site["lon"]):
                found = ["position differs from sites.json"]
            add(f"{kind}/{sid}", found)

    known = {"sites.json", "ephem.json", "ephem.bin", "manifest.json"}
    for sid in ids:
        known |= {f"skylines/{sid}.json", f"terrain/{sid}.json", f"terrain/{sid}.bin",
                  f"shade/{sid}.json", f"shade/{sid}_skyline.bin", f"shade/{sid}_normal.bin"}
    for path in sorted(p.relative_to(folder).as_posix() for p in folder.rglob("*") if p.is_file()):
        if path not in known:
            problems.append(f"{path}: does not belong to any site in sites.json")

    if manifest is not None:
        on_disk = {p.relative_to(folder).as_posix(): p.stat().st_size
                   for p in folder.rglob("*") if p.is_file() and p.name != "manifest.json"}
        listed = {entry["path"]: entry["bytes"] for entry in manifest["files"]}
        for path in sorted(set(on_disk) - set(listed)):
            problems.append(f"manifest.json: {path} exists but is not listed")
        for path in sorted(set(listed) - set(on_disk)):
            problems.append(f"manifest.json: {path} is listed but does not exist")
        for path in sorted(set(listed) & set(on_disk)):
            if listed[path] != on_disk[path]:
                problems.append(f"manifest.json: {path} is {on_disk[path]} bytes, listed as {listed[path]}")
        flags = {s["id"]: (s["has_terrain"], s["has_shade_grid"]) for s in manifest["sites"]}
        expected = {s["id"]: (s["has_terrain"], s["has_shade_grid"]) for s in sites}
        if flags != expected:
            problems.append("manifest.json: site flags differ from sites.json")
    return problems
