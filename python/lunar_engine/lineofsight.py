"""Line-of-sight checks through the terrain: the independent second method.

Role
    Referee for the skyline (spec section 7, "Independent cross-check"). It
    answers the same questions as the skyline engine by a different route
    and shares none of its search code: only the terrain surface
    (:mod:`lunar_engine.elevation`) and the basic geometry.

    * :func:`ray_blocked`: is a straight line of sight from the eye, in a
      given direction, stopped by the terrain?
    * :func:`azimuth_profile`: the skyline at single exact azimuths, by
      sampling the terrain densely along each azimuth.

How it works, in plain words
    A line of sight is followed outward from the eye in small steps (1/8 of
    the finest pixel, measured along the ground). At each step the point on
    the line is compared with the terrain directly below or above it; if the
    terrain is higher, the line is blocked. Beyond the maps, the line is
    blocked if it ever comes closer to the Moon's centre than the highest
    terrain that could be there.

    A line is also given up as clear once it is higher above the reference
    sphere than any terrain could be and still climbing.

    This is a sampling method, not a proof: a feature narrower than a step
    could slip between two steps. Steps of 1/8 pixel on a surface that is
    smooth between pixel centres make that a matter of millimetres.

Units: degrees and metres.
"""

from __future__ import annotations

import numpy as np

from .elevation import ElevationSource, unit_to_xy, xy_to_unit
from .geometry import R_MOON_M, enu_frame

#: Ground closer than this to the point under the eye is ignored, metres
#: (the same convention as the skyline engine).
EXCLUDE_RADIUS_M = 1.0


def terrain_height(source: ElevationSource, x, y) -> np.ndarray:
    """Terrain height at sheet points from the finest map trusted there, metres.

    NaN outside every map's trusted disc.
    """
    x, y = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
    out = np.full(x.shape, np.nan)
    for grid in reversed(source.grids):                 # finest last, so it wins
        cx, cy, radius = grid.disc()
        inside = np.hypot(x - cx, y - cy) <= radius
        if inside.any():
            out[inside] = grid.height_xy(x[inside], y[inside])
    return out


def _reach_m(source: ElevationSource, site_unit: np.ndarray) -> float:
    """Farthest ground distance at which any map could still have data, metres."""
    best = 0.0
    for grid in source.grids:
        cx, cy, radius = grid.disc()
        centre = xy_to_unit(cx, cy)
        angle = 2.0 * np.arcsin(min(1.0, float(np.linalg.norm(centre - site_unit)) / 2.0))
        best = max(best, angle * R_MOON_M + radius)
    return best


def ray_blocked(source: ElevationSource, lat_deg: float, lon_deg: float, mast_m: float,
                az_deg, el_deg, batch: int = 64) -> np.ndarray:
    """Whether lines of sight from the eye are stopped by terrain.

    Args:
        source: the terrain.
        lat_deg, lon_deg, mast_m: the observer.
        az_deg, el_deg: directions, degrees (arrays of equal length).
        batch: lines followed at once (memory).

    Returns:
        Array of True (blocked), False (clear) or None (it would depend on
        unmapped terrain beyond the maps).
    """
    east, north, up = enu_frame(lat_deg, lon_deg)
    elev = source.height(lat_deg, lon_deg)
    eye = (R_MOON_M + elev + mast_m) * up
    az = np.radians(np.atleast_1d(np.asarray(az_deg, dtype=float)))
    el = np.radians(np.atleast_1d(np.asarray(el_deg, dtype=float)))
    step = source.grids[0].spec.pixel_m / 8.0
    reach = _reach_m(source, up)
    highest = max([source.unknown_height_m]
                  + [float(g.pyramid(source.unknown_height_m)[-1][0, 0]) for g in source.grids])
    result = np.empty(len(az), dtype=object)
    for start in range(0, len(az), batch):
        a, e = az[start:start + batch], el[start:start + batch]
        d = (np.cos(e) * np.sin(a))[:, None] * east + (np.cos(e) * np.cos(a))[:, None] * north \
            + np.sin(e)[:, None] * up                                         # (B, 3)
        # Length after which a line is above any terrain and climbing:
        # |eye + t d|^2 = (R + highest)^2, taking the later root.
        b = d @ eye
        c = eye @ eye - (R_MOON_M + highest) ** 2
        safe = np.where(b * b - c >= 0.0, -b + np.sqrt(np.maximum(b * b - c, 0.0)), 0.0)
        safe = np.maximum(safe, np.maximum(-b, 0.0))
        # Follow each line until it is above everything, or until its foot has
        # left the data (the foot moves at least cos(elevation) times as fast
        # as the line, near enough; 1.2 for the Moon's curvature and margin).
        leaves = reach * 1.2 / np.maximum(np.cos(e), 1e-6)
        longest = float(np.minimum(safe, leaves).max())
        lengths = np.arange(EXCLUDE_RADIUS_M, longest + 2 * step, step)
        points = eye + lengths[None, :, None] * d[:, None, :]                  # (B, M, 3)
        radius = np.linalg.norm(points, axis=-1)
        foot = points / radius[..., None]
        ground = 2.0 * R_MOON_M * np.arcsin(np.clip(np.linalg.norm(foot - up, axis=-1) / 2.0, 0, 1))
        x, y = unit_to_xy(foot)
        h = terrain_height(source, x.ravel(), y.ravel()).reshape(x.shape)
        considered = ground >= EXCLUDE_RADIUS_M
        hit = considered & np.isfinite(h) & (radius - R_MOON_M < h)
        blocked = hit.any(axis=1)
        # Beyond the maps: closest approach of the line to the Moon's centre,
        # from the last point that still had data.
        has_data = np.isfinite(h) & considered
        last = np.where(has_data.any(axis=1), has_data.shape[1] - 1 - np.argmax(has_data[:, ::-1], axis=1), 0)
        t_last = lengths[last]
        t_closest = np.maximum(-(d @ eye), t_last)
        closest = np.linalg.norm(eye + t_closest[:, None] * d, axis=-1)
        unknown = ~blocked & (closest - R_MOON_M < source.unknown_height_m)
        unknown &= lengths[-1] < safe                   # lines that got above everything are clear
        for i in range(len(a)):
            result[start + i] = True if blocked[i] else (None if unknown[i] else False)
    return result


def azimuth_profile(source: ElevationSource, lat_deg: float, lon_deg: float, mast_m: float,
                    az_deg, max_distance_m: float | None = None) -> np.ndarray:
    """The skyline at exact azimuths, by dense sampling along each azimuth, degrees.

    For each azimuth, the terrain is sampled every 1/8 of the finest pixel
    along the ground, out to the edge of the data, and the highest elevation
    angle seen from the eye is returned. This equals the lowest elevation at
    which a line of sight in that azimuth clears the terrain.
    """
    east, north, up = enu_frame(lat_deg, lon_deg)
    elev = source.height(lat_deg, lon_deg)
    eye = (R_MOON_M + elev + mast_m) * up
    step = source.grids[0].spec.pixel_m / 8.0
    reach = max_distance_m if max_distance_m is not None else _reach_m(source, up)
    t = np.arange(EXCLUDE_RADIUS_M, reach, step) / R_MOON_M
    az = np.radians(np.atleast_1d(np.asarray(az_deg, dtype=float)))
    out = np.empty(len(az))
    for start in range(0, len(az), 16):
        a = az[start:start + 16]
        heading = np.cos(a)[:, None] * north + np.sin(a)[:, None] * east
        u = np.cos(t)[None, :, None] * up + np.sin(t)[None, :, None] * heading[:, None, :]
        x, y = unit_to_xy(u)
        h = terrain_height(source, x.ravel(), y.ravel()).reshape(x.shape)
        d = (R_MOON_M + h)[..., None] * u - eye
        el = np.degrees(np.arctan2(d @ up, np.hypot(d @ east, d @ north)))
        out[start:start + 16] = np.nanmax(el, axis=1)
    return out
