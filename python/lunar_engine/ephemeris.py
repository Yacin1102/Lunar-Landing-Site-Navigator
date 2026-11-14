"""Where the Sun and the Earth are, from SPICE.

Role
    Two jobs (spec sections 5 and 10):

    * **Builder**: the Sun/Earth timetable, vectors from the Moon's centre
      (Contract 1).
    * **Referee**: the direction of the Sun and the Earth seen from a point on
      the surface, computed directly for that point. This is the known-correct
      answer the browser's arithmetic is tested against, and it does not use
      the timetable.

How it works, in plain words
    SPICE is asked where a body appears to be at a given moment: "appears"
    means corrected for the time light takes to arrive and for the motion of
    the observer (the ``LT+S`` correction). The answer is a vector in the
    Moon-fixed frame ``MOON_ME``. For a surface point the observer is placed
    at that point, fixed to the rotating Moon.

Units: positions in km, angles in degrees, times in UTC milliseconds since
1970. Kernels must be loaded with :func:`lunar_engine.spice_env.loaded`.
"""

from __future__ import annotations

import numpy as np
import spiceypy as spice

from .geometry import R_MOON_M, az_el_in_frame, enu_frame
from .spice_env import et_from_utc_ms

#: SPICE correction for apparent positions: light time plus stellar aberration.
ABERRATION = "LT+S"
FRAME = "MOON_ME"

#: Timetable start, 16 Nov 2026 00:00 UTC, and step (Contract 1).
T0_MS = 1_794_787_200_000
STEP_S = 3600
#: The timetable must reach 1 Jan 2040 00:00 UTC, inclusive.
END_MS = 2_208_988_800_000
ROW_COUNT = (END_MS - T0_MS) // (STEP_S * 1000) + 1

#: Radius used for the Earth's disc, km: the polar radius in pck00011.tpc.
#: The Earth is flattened, and seen from the Moon's south pole the upper edge
#: of its disc is near one of the Earth's poles. There the true limb is
#: between 6356.75 and about 6365 km from the centre, depending on the date.
#: The polar radius is therefore within about 0.0012 degrees of the true
#: upper edge and never above it: the Earth's edge is never said to be
#: visible when it is not. (The equatorial radius, 6378.14 km, would put the
#: edge up to 0.0032 degrees too high.)
EARTH_RADIUS_KM = 6356.7519
#: Radius used for the Sun's disc, km: the value in pck00011.tpc.
SUN_RADIUS_KM = 695_700.0


def moon_centre_vectors(t_ms, aberration: str = ABERRATION) -> np.ndarray:
    """Apparent Sun and Earth positions seen from the Moon's centre.

    Args:
        t_ms: array of UTC times, milliseconds since 1970.
        aberration: SPICE correction; the default is the one every product
            uses. ``"NONE"`` (no correction) exists for tests only.

    Returns:
        Array of shape ``(n, 6)``, km, ``MOON_ME``: ``sun_x, sun_y, sun_z,
        earth_x, earth_y, earth_z`` (the Contract 1 column order), as
        64-bit numbers.
    """
    ets = np.atleast_1d(et_from_utc_ms(t_ms))
    out = np.empty((len(ets), 6))
    for i, et in enumerate(ets):
        out[i, :3] = spice.spkpos("SUN", float(et), FRAME, aberration, "MOON")[0]
        out[i, 3:] = spice.spkpos("EARTH", float(et), FRAME, aberration, "MOON")[0]
    return out


def site_vector_km(lat_deg: float, lon_deg: float, elev_m: float = 0.0,
                   mast_m: float = 0.0) -> np.ndarray:
    """Position of the eye at a site, from the Moon's centre, km, ``MOON_ME``.

    The eye is ``elev_m + mast_m`` above the 1737.4 km sphere along the local
    vertical.
    """
    _, _, up = enu_frame(lat_deg, lon_deg)
    return (R_MOON_M + elev_m + mast_m) / 1000.0 * up


def direct_view(body: str, lat_deg: float, lon_deg: float, elev_m: float,
                mast_m: float, t_ms: float,
                aberration: str = ABERRATION) -> tuple[float, float, float]:
    """Direction and distance of a body seen from a surface point, directly from SPICE.

    The observer is the site itself, fixed to the Moon, so light time and
    aberration are worked out for that exact point. Nothing is interpolated.

    Args:
        body: ``"SUN"`` or ``"EARTH"``.
        lat_deg, lon_deg: the site, degrees.
        elev_m, mast_m: ground height above the sphere and eye height, metres.
        t_ms: UTC time, milliseconds since 1970.
        aberration: SPICE correction; ``"NONE"`` exists for tests only.

    Returns:
        ``(azimuth_deg, elevation_deg, distance_km)`` of the body's centre.
        Azimuth from north, clockwise, 0 to 360 (excluded).
    """
    et = float(et_from_utc_ms(t_ms))
    site = site_vector_km(lat_deg, lon_deg, elev_m, mast_m)
    state, _ = spice.spkcpo(body, et, FRAME, "OBSERVER", aberration, site, "MOON", FRAME)
    east, north, up = enu_frame(lat_deg, lon_deg)
    azimuth, elevation = az_el_in_frame(state[:3], east, north, up)
    return float(azimuth), float(elevation), float(np.linalg.norm(state[:3]))


def angular_radius_deg(body_radius_km: float, distance_km: float) -> float:
    """Angular radius of a sphere seen from a distance, degrees (exact: asin(r/d))."""
    return float(np.degrees(np.arcsin(body_radius_km / distance_km)))


# ---- What the browser does, written in Python --------------------------------
# Used by the tests to prove the timetable is good enough: the same steps the
# TypeScript side takes, so their error can be measured against direct_view.

def interpolate_rows(rows: np.ndarray, t0_ms: int, step_s: float, t_ms: float) -> np.ndarray:
    """Timetable value at any time, by a cubic curve through four rows.

    This is the recommended method for the web app: take the two rows before
    and the two rows after the time and fit the unique cubic through them
    (4-point Lagrange interpolation). In the first and last interval the four
    nearest rows are used.

    Args:
        rows: timetable, shape ``(count, 6)``, km.
        t0_ms, step_s: from the label.
        t_ms: UTC time, milliseconds since 1970, within the timetable.

    Returns:
        The six interpolated values, km.
    """
    count = len(rows)
    x = (t_ms - t0_ms) / (step_s * 1000.0)
    if not 0 <= x <= count - 1:
        raise ValueError("time is outside the timetable")
    first = min(max(int(np.floor(x)) - 1, 0), count - 4)
    u = x - first                              # position among rows first..first+3: 0..3
    weights = np.array([
        -(u - 1) * (u - 2) * (u - 3) / 6,
        u * (u - 2) * (u - 3) / 2,
        -u * (u - 1) * (u - 3) / 2,
        u * (u - 1) * (u - 2) / 6,
    ])
    return weights @ np.asarray(rows[first:first + 4], dtype=float)


def view_from_rows(vector_km: np.ndarray, lat_deg: float, lon_deg: float,
                   elev_m: float, mast_m: float) -> tuple[float, float, float]:
    """Direction of a body from its Moon-centre vector, the way the browser does it.

    Subtract the site's position from the Moon-centre vector, then read
    azimuth and elevation in the site's east/north/up frame.

    Returns:
        ``(azimuth_deg, elevation_deg, distance_km)``.
    """
    d = np.asarray(vector_km, dtype=float) - site_vector_km(lat_deg, lon_deg, elev_m, mast_m)
    east, north, up = enu_frame(lat_deg, lon_deg)
    azimuth, elevation = az_el_in_frame(d, east, north, up)
    return float(azimuth), float(elevation), float(np.linalg.norm(d))
