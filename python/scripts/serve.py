"""Run the live skyline API on this machine.

Role
    Starts the server of :mod:`lunar_engine.server` on http://localhost:8000,
    the address the web app calls by default (``VITE_API_BASE_URL``).

Modes
    ``--synthetic``
        An invented landscape round the south pole (cones and a crater on a
        sphere, 50 m pixels, 25 km round the pole), for developing the web
        app before the real maps are wired in. ``/api/health`` then reports
        ``"real_terrain": false``, and its answers must never be shown as
        real verdicts. Requests farther than about 0.8 degrees from the pole
        are refused, because the invented map ends there.
    (The real LOLA maps are added with the map reader.)

Usage (from the repository root)
    python python/scripts/serve.py --synthetic
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lunar_engine.geometry import R_MOON_M, enu_frame, lat_lon_radius  # noqa: E402
from lunar_engine.server import create_app  # noqa: E402
from lunar_engine.synthetic import Cone, Dome, SyntheticElevation  # noqa: E402

import numpy as np  # noqa: E402


def synthetic_world() -> SyntheticElevation:
    """The invented landscape served by ``--synthetic`` (repeatable)."""
    rng = np.random.default_rng(2026)
    shapes = [Dome(-89.75, 130.0, 6_000.0, -2_500.0)]
    east, north, up = enu_frame(-89.999, 0.0)
    for _ in range(40):
        distance, azimuth = rng.uniform(2_000.0, 20_000.0), rng.uniform(0.0, 2 * np.pi)
        t = distance / R_MOON_M
        lat, lon, _ = lat_lon_radius(np.cos(t) * up + np.sin(t) * (np.cos(azimuth) * north
                                                                   + np.sin(azimuth) * east))
        shapes.append(Cone(float(lat), float(lon), rng.uniform(500.0, 3_000.0), rng.uniform(50.0, 900.0)))
    return SyntheticElevation(shapes, grids=[(50.0, 25_000.0)], center=(-90.0, 0.0),
                              beyond_maps_height_m=0.0, error_m=0.5)


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point."""
    parser = argparse.ArgumentParser(description="Run the live skyline API.")
    parser.add_argument("--synthetic", action="store_true", help="serve an invented landscape")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args(argv)
    if not args.synthetic:
        print("Only --synthetic is available until the real map reader is added.")
        return 1
    import uvicorn

    world = synthetic_world()
    region = {"lat_min": -90.0, "lat_max": round(world.service_lat_max(), 5)}
    print(f"Serving SYNTHETIC terrain (not NASA data), latitudes {region['lat_min']} to {region['lat_max']}.")
    uvicorn.run(create_app(world, service_region=region), host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
