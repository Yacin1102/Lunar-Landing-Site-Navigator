"""Generate ``web/engine/types.ts`` from the JSON Schemas.

Role
    The schemas in ``docs/schemas/`` are the machine-readable form of the data
    contracts. This script turns them into TypeScript interfaces so the web
    app and the Python engine cannot drift apart: the types are never edited
    by hand, and a test fails if the committed file differs from what this
    script produces.

How it works, in plain words
    Every schema object that has a ``title`` becomes an ``interface`` of that
    name; its ``description`` becomes the doc comment. Fields not listed in
    ``required`` become optional. Numbers and integers both become ``number``.

Usage (from the repository root)
    python python/scripts/gen_types.py           write web/engine/types.ts
    python python/scripts/gen_types.py --check   exit 1 if the file is stale
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parents[2]
SCHEMA_DIR = REPO_DIR / "docs" / "schemas"
OUTPUT = REPO_DIR / "web" / "engine" / "types.ts"

#: Order of the schemas in the output.
SCHEMA_NAMES = ("ephem", "sites", "skyline", "terrain", "shade", "manifest",
                "altaz", "events")

HEADER = """\
// GENERATED FILE - do not edit by hand.
// Source: docs/schemas/*.schema.json   Generator: python/scripts/gen_types.py
//
// Data contracts between the Python engine and the web app
// (spec/ENGINE_GUIDE.md, explained in docs/WEB_HANDOFF.md).
//
// Shared rules: angles in degrees; azimuth from north, clockwise; longitude
// east positive, -180 to 180; heights and distances in metres; Sun/Earth
// positions in km; times in UTC milliseconds since 1970; frame MOON_ME;
// height reference sphere of radius 1737.4 km.
"""

FOOTER = """\
/** Radius of the height reference sphere, metres. */
export const MOON_RADIUS_M = 1737400;

/** Order of the six Float32 values in each row of ephem.bin. */
export const EPHEM_COLUMNS = ["sun_x", "sun_y", "sun_z", "earth_x", "earth_y", "earth_z"] as const;

/** Bytes per row of ephem.bin (six little-endian Float32). */
export const EPHEM_ROW_BYTES = 24;
"""


def _comment(text: str, indent: str) -> list[str]:
    """A doc comment, wrapped at about 90 characters."""
    words, lines, line = text.split(), [], ""
    for word in words:
        if line and len(line) + 1 + len(word) > 88:
            lines.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    lines.append(line)
    if len(lines) == 1:
        return [f"{indent}/** {lines[0]} */"]
    return [f"{indent}/**"] + [f"{indent} * {text_line}" for text_line in lines] + [f"{indent} */"]


def _ts_type(schema: dict, interfaces: dict[str, list[str]]) -> str:
    """TypeScript type for a schema node; registers interfaces it meets."""
    if "const" in schema:
        return json.dumps(schema["const"])
    if "enum" in schema:
        return " | ".join(json.dumps(value) for value in schema["enum"])
    kind = schema.get("type")
    if kind in ("number", "integer"):
        return "number"
    if kind in ("string", "boolean"):
        return kind
    if kind == "array":
        if "prefixItems" in schema:
            return "[" + ", ".join(_ts_type(item, interfaces) for item in schema["prefixItems"]) + "]"
        inner = _ts_type(schema["items"], interfaces)
        return f"({inner})[]" if " | " in inner else f"{inner}[]"
    if kind == "object":
        _interface(schema, interfaces)
        return schema["title"]
    raise ValueError(f"unsupported schema node: {schema}")


def _interface(schema: dict, interfaces: dict[str, list[str]]) -> None:
    """Register the interface for an object schema (once per title)."""
    title = schema["title"]
    lines = _comment(schema["description"], "") + [f"export interface {title} {{"]
    required = set(schema.get("required", []))
    for name, prop in schema["properties"].items():
        ts = _ts_type(prop, interfaces)
        lines += _comment(prop["description"], "  ")
        lines.append(f"  {name}{'' if name in required else '?'}: {ts};")
    lines.append("}")
    if title in interfaces and interfaces[title] != lines:
        raise ValueError(f"two different schemas are both titled {title}")
    interfaces[title] = lines


def generate() -> str:
    """Return the full text of ``types.ts``."""
    interfaces: dict[str, list[str]] = {}
    for name in SCHEMA_NAMES:
        schema = json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text(encoding="utf-8"))
        _interface(schema, interfaces)
    blocks = ["\n".join(lines) for lines in interfaces.values()]
    return HEADER + "\n" + "\n\n".join(blocks) + "\n\n" + FOOTER


def main(argv: list[str] | None = None) -> int:
    """Write the file, or with ``--check`` only compare. Returns the exit code."""
    args = sys.argv[1:] if argv is None else argv
    text = generate()
    if "--check" in args:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != text:
            print(f"{OUTPUT} is stale: run python python/scripts/gen_types.py")
            return 1
        print(f"{OUTPUT} is up to date.")
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
