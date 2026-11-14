"""Exact geometry on the Moon's reference sphere.

Role
    The small set of conversions every other module shares: latitude and
    longitude to a direction, the local east/north/up frame at a point, and
    back. Implements the shared rules of spec section 4.

Conventions (shared rules)
    * Latitude in degrees, -90 to 90. Longitude in degrees, east positive,
      reported in -180 (included) to 180 (excluded).
    * Azimuth in degrees from north, clockwise (90 = east).
    * Heights are metres above the sphere of radius 1737.4 km.
    * Vectors are Cartesian in the Moon-fixed frame ``MOON_ME``: +z through
      the north pole, +x through latitude 0, longitude 0 (the mean direction
      of the Earth).

All formulas are exact for a sphere. There are no flat-ground or small-angle
approximations here.
"""

from __future__ import annotations

import numpy as np

#: Radius of the height reference sphere, metres (spec section 4).
R_MOON_M = 1_737_400.0


def wrap_lon(lon_deg):
    """Bring a longitude into -180 (included) to 180 (excluded) degrees.

    >>> float(wrap_lon(190.0)), float(wrap_lon(-180.0)), float(wrap_lon(180.0))
    (-170.0, -180.0, -180.0)
    """
    return (np.asarray(lon_deg, dtype=float) + 180.0) % 360.0 - 180.0


def unit_vector(lat_deg, lon_deg) -> np.ndarray:
    """Direction from the Moon's centre to a latitude/longitude.

    Args:
        lat_deg, lon_deg: degrees; arrays of the same shape are accepted.

    Returns:
        Unit vector(s), shape ``(..., 3)``, in ``MOON_ME``.
    """
    lat = np.radians(np.asarray(lat_deg, dtype=float))
    lon = np.radians(np.asarray(lon_deg, dtype=float))
    cos_lat = np.cos(lat)
    return np.stack([cos_lat * np.cos(lon), cos_lat * np.sin(lon), np.sin(lat)], axis=-1)


def enu_frame(lat_deg: float, lon_deg: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Local east, north and up directions at a point.

    "Up" is away from the Moon's centre (the true local vertical of the
    reference sphere). "North" is along the meridian toward the north pole,
    so at a south polar site it points away from the south pole. "East"
    completes the right-handed set (east x north = up). At the pole itself
    north is undefined; callers nudge the point off the pole (spec section 4).

    Returns:
        ``(east, north, up)``, each a unit vector of shape ``(3,)`` in ``MOON_ME``.
    """
    lat = np.radians(float(lat_deg))
    lon = np.radians(float(lon_deg))
    east = np.array([-np.sin(lon), np.cos(lon), 0.0])
    north = np.array([-np.sin(lat) * np.cos(lon), -np.sin(lat) * np.sin(lon), np.cos(lat)])
    up = np.array([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])
    return east, north, up


def lat_lon_radius(vectors) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Latitude, longitude and distance from the centre of Cartesian points.

    Args:
        vectors: shape ``(..., 3)``, any length unit.

    Returns:
        ``(lat_deg, lon_deg, radius)``; ``radius`` is in the unit of the input.
    """
    v = np.asarray(vectors, dtype=float)
    radius = np.linalg.norm(v, axis=-1)
    lat = np.degrees(np.arcsin(np.clip(v[..., 2] / radius, -1.0, 1.0)))
    lon = wrap_lon(np.degrees(np.arctan2(v[..., 1], v[..., 0])))
    return lat, lon, radius


def az_el_in_frame(directions, east, north, up) -> tuple[np.ndarray, np.ndarray]:
    """Azimuth and elevation of directions seen in a local frame.

    Args:
        directions: vectors of shape ``(..., 3)`` in ``MOON_ME`` (any length).
        east, north, up: the frame from :func:`enu_frame`.

    Returns:
        ``(azimuth_deg, elevation_deg)``. Azimuth is from north, clockwise,
        0 to 360 (excluded). Elevation is above the local level plane,
        negative below.
    """
    d = np.asarray(directions, dtype=float)
    length = np.linalg.norm(d, axis=-1)
    e, n, u = d @ east, d @ north, d @ up
    azimuth = np.degrees(np.arctan2(e, n)) % 360.0
    # A tiny negative angle rounds up to exactly 360.0; that is azimuth 0.
    azimuth = np.where(azimuth >= 360.0, 0.0, azimuth)
    elevation = np.degrees(np.arcsin(np.clip(u / length, -1.0, 1.0)))
    return azimuth, elevation
