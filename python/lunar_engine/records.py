"""Skyline records: the one place a Contract 3 skyline is made and written.

Role
    The Builder (``skylines/{id}.json``) and the live API (``/api/skyline``)
    must give identical answers for the same point and parameters (spec
    section 11). Both call :func:`skyline_record`, so there is only one way a
    skyline record can be produced.

Rounding, in plain words
    Numbers are written with 6 decimals (a millionth of a degree), which keeps
    files small without losing anything that matters. Rounding moves a value
    by up to half a millionth of a degree, so the error bound is widened by
    exactly what rounding took away and then rounded **up**: the written
    interval ``skyline_deg +/- skyline_err_deg`` always contains the computed
    one. Every record is checked against its contract before it is returned.

Units: degrees, metres, km (``max_reach_km``).
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from . import contracts, products
from .elevation import ElevationSource
from .uncertainty import SkylineBounds, skyline_with_error

#: Decimals kept for angles in records.
ANGLE_DECIMALS = 6


def _round_interval(centre: np.ndarray, half_width: np.ndarray) -> tuple[list, list]:
    """Round an interval so that the rounded one still contains the original.

    Returns:
        ``(centre, half_width)`` as lists of floats with ``ANGLE_DECIMALS``
        decimals.
    """
    scale = 10.0 ** ANGLE_DECIMALS
    centre_r = np.round(centre * scale) / scale
    needed = half_width + np.abs(centre - centre_r)
    half_r = np.ceil(needed * scale - 1e-9) / scale
    half_r = np.where(half_r < needed, half_r + 1.0 / scale, half_r)     # guard against rounding of the guard
    return [float(v) for v in centre_r], [float(v) for v in np.round(half_r, ANGLE_DECIMALS)]


def record_from_bounds(bounds: SkylineBounds) -> dict:
    """Turn a computed skyline with its error bound into a Contract 3 record.

    Raises:
        ValueError: if the record would break its contract (this would be a
            bug, never a matter of the input).
    """
    skyline, err = _round_interval(bounds.skyline_deg, bounds.skyline_err_deg)
    record = {
        "version": 1,
        "lat": float(bounds.lat),
        "lon": float(bounds.lon),
        "elev_m": round(float(bounds.elev_m), 3),
        "mast_m": float(bounds.mast_m),
        "az_step_deg": float(bounds.az_step_deg),
        "skyline_deg": skyline,
        "skyline_err_deg": err,
        "dem": list(bounds.dem),
        "resolution_m": float(bounds.resolution_m),
        "max_reach_km": round(float(bounds.max_reach_km), 3),
    }
    problems = contracts.skyline_problems(record)
    if problems:
        raise ValueError("skyline record breaks its contract: " + "; ".join(problems))
    return record


def skyline_record(source: ElevationSource, lat_deg: float, lon_deg: float,
                   mast_m: float, az_step_deg: float) -> dict:
    """Compute the skyline at a point and return its Contract 3 record.

    The single function behind both the Builder and the live API.

    Args:
        source: the terrain.
        lat_deg, lon_deg: the point exactly as it should appear in the record,
            degrees.
        mast_m: eye height above the ground, metres.
        az_step_deg: wedge width, degrees.

    Raises:
        ValueError, CoverageError: as :func:`lunar_engine.uncertainty.skyline_with_error`.
    """
    return record_from_bounds(skyline_with_error(source, lat_deg, lon_deg, mast_m, az_step_deg))


def write_skyline(folder: Path, site_id: str, record: dict) -> Path:
    """Write ``skylines/{site_id}.json`` into a data folder; returns its path."""
    if not site_id or not all(c.islower() or c.isdigit() or c in "_-" for c in site_id):
        raise ValueError(f"site id {site_id!r} is not lowercase letters, digits, _ or -")
    path = Path(folder) / "skylines" / f"{site_id}.json"
    products.write_json(path, record, compact=True)
    return path


def contains(record: dict, wedge: int, elevation_deg: float) -> bool:
    """True if an elevation lies within the record's interval for a wedge."""
    centre, half = record["skyline_deg"][wedge], record["skyline_err_deg"][wedge]
    return centre - half <= elevation_deg <= centre + half and not math.isnan(elevation_deg)
