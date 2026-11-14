"""A made-up south polar landscape for mock data.

Role
    Produces contract-exact files for the web side to develop against before
    any real product exists (``web/public/data-mock/``). The landscape is
    invented: a sphere with a few smooth craters and mountains given by
    formulas. Nothing here is NASA data, and nothing here is the precision
    skyline engine.

How it works, in plain words
    * ``height_m`` is a formula: the reference sphere plus a list of round
      features (a crater with a raised rim, mountains).
    * A skyline is found by brute force: for each azimuth, walk outward along
      that direction in about 1 % steps out to 600 km, find the ground height
      at each step, and keep the steepest upward angle seen. Because the
      features are smooth and kilometres wide, this is good to a few
      hundredths of a degree, which is what the mock ``skyline_err_deg`` says.
    * All positions and angles are computed in three dimensions on the
      sphere, in the local east/north/up frame of the site, so the mock files
      follow exactly the same geometric conventions as the real ones.

Units: degrees, metres, ``MOON_ME``; see :mod:`lunar_engine.geometry`.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .geometry import R_MOON_M, enu_frame, unit_vector

#: Name written into the ``dem`` field of every mock file.
MOCK_DEM_NAME = "SYNTHETIC (mock landscape, not NASA data)"
#: Uncertainty written into mock skylines, degrees.
MOCK_SKYLINE_ERR_DEG = 0.03
#: How far the mock skyline search walks, km.
MOCK_REACH_KM = 600.0
#: Nominal pixel size reported by mock files, metres.
MOCK_RESOLUTION_M = 20.0


@dataclass(frozen=True)
class Feature:
    """One round landform.

    Height at surface distance ``r`` from the centre, in metres::

        height * exp(-(r / radius)^2) + rim * exp(-((r - radius) / (radius/4))^2)

    A negative ``height`` is a crater; ``rim`` adds a raised ring at its edge.

    Attributes:
        lat, lon: centre, degrees.
        radius_m: size of the feature, metres along the surface.
        height_m: height (or depth, if negative) at the centre, metres.
        rim_m: height of the raised rim, metres (0 for none).
    """

    lat: float
    lon: float
    radius_m: float
    height_m: float
    rim_m: float = 0.0


#: The invented landscape. Loosely shaped like the real south pole so the
#: mock behaves plausibly: a deep crater near the pole, mountains further out.
FEATURES = (
    Feature(-89.60, 130.0, 10_000.0, -4_000.0, 1_200.0),   # deep polar crater with a rim
    Feature(-86.00, 0.0, 25_000.0, 5_000.0),               # near-side mountain
    Feature(-87.20, -70.0, 18_000.0, -3_000.0, 800.0),     # second crater
    Feature(-88.30, -120.0, 12_000.0, 2_500.0),            # ridge-like peak
    Feature(-84.50, 150.0, 40_000.0, 3_500.0),             # far-side highland
    Feature(-83.00, 60.0, 30_000.0, -2_500.0, 600.0),      # outer crater
)


def height_m(points) -> np.ndarray:
    """Ground height of the mock landscape under given directions.

    Args:
        points: Cartesian vectors of shape ``(..., 3)`` in ``MOON_ME``. Only
            their direction matters.

    Returns:
        Height in metres above the 1737.4 km sphere, shape ``(...)``.
    """
    p = np.asarray(points, dtype=float)
    direction = p / np.linalg.norm(p, axis=-1, keepdims=True)
    total = np.zeros(direction.shape[:-1])
    for feature in FEATURES:
        centre = unit_vector(feature.lat, feature.lon)
        # Exact surface distance from the feature centre along the sphere,
        # from the straight-line (chord) distance between the two directions.
        chord = np.linalg.norm(direction - centre, axis=-1)
        r = 2.0 * R_MOON_M * np.arcsin(np.clip(chord / 2.0, 0.0, 1.0))
        total += feature.height_m * np.exp(-(r / feature.radius_m) ** 2)
        if feature.rim_m:
            total += feature.rim_m * np.exp(-((r - feature.radius_m) / (feature.radius_m / 4)) ** 2)
    return total


def height_at(lat_deg: float, lon_deg: float) -> float:
    """Ground height at a latitude/longitude, metres above the sphere."""
    return float(height_m(unit_vector(lat_deg, lon_deg)))


def _surface_up_coordinate(base: np.ndarray, up: np.ndarray, start=None,
                           rounds: int = 6) -> np.ndarray:
    """Find where the vertical line through each base point meets the ground.

    For each point ``base`` (metres, ``MOON_ME``) find ``t`` such that
    ``base + t * up`` lies on the mock surface. ``up`` is the frame's vertical,
    which is not the local vertical away from the frame's origin, so the
    answer is found by a few rounds of correction (each round fixes the
    remaining miss; six rounds settle to well under a millimetre).

    Returns:
        ``t`` in metres, shape ``base.shape[:-1]``.
    """
    t = np.zeros(base.shape[:-1]) if start is None else np.array(start, dtype=float)
    for _ in range(rounds):
        point = base + t[..., None] * up
        radius = np.linalg.norm(point, axis=-1)
        miss = (R_MOON_M + height_m(point)) - radius
        t = t + miss / ((point @ up) / radius)
    return t


def skyline_in_frame(observer: np.ndarray, east: np.ndarray, north: np.ndarray,
                     up: np.ndarray, azimuths_deg: np.ndarray,
                     n_steps: int = 1200) -> np.ndarray:
    """Brute-force skyline of the mock landscape seen from one point.

    Args:
        observer: eye position, metres, ``MOON_ME``.
        east, north, up: the frame in which azimuth and elevation are measured.
        azimuths_deg: azimuths to evaluate, degrees from ``north`` clockwise.
        n_steps: number of distances tried along each azimuth.

    Returns:
        For each azimuth, the highest elevation angle (degrees above the
        frame's level plane) at which ground appears, over horizontal
        distances from 2 m to 600 km.
    """
    az = np.radians(np.asarray(azimuths_deg, dtype=float))
    heading = np.cos(az)[:, None] * north + np.sin(az)[:, None] * east          # (A, 3)
    steps = np.geomspace(2.0, MOCK_REACH_KM * 1000.0, n_steps)                  # (S,)
    best = np.full(len(az), -90.0)
    for start in range(0, len(az), 240):                                        # limit memory
        h = heading[start:start + 240]
        base = observer + steps[None, :, None] * h[:, None, :]                  # (a, S, 3)
        # First guess: the sphere's drop below the frame's level plane.
        guess = -steps ** 2 / (2 * R_MOON_M) * np.ones(base.shape[:-1])
        t = _surface_up_coordinate(base, up, guess)
        elevation = np.degrees(np.arctan2(t, steps[None, :]))
        best[start:start + 240] = elevation.max(axis=1)
    return best


def site_skyline(lat_deg: float, lon_deg: float, mast_m: float, az_step_deg: float) -> dict:
    """Mock skyline record for a point, in the Contract 3 layout.

    Args:
        lat_deg, lon_deg: the point, degrees.
        mast_m: eye height above the ground, metres.
        az_step_deg: spacing between azimuths, degrees; must divide 360.

    Returns:
        A dict with every Contract 3 field, angles rounded to 0.0001 degrees.
    """
    count = int(round(360.0 / az_step_deg))
    east, north, up = enu_frame(lat_deg, lon_deg)
    elev = height_at(lat_deg, lon_deg)
    observer = (R_MOON_M + elev + mast_m) * up
    skyline = skyline_in_frame(observer, east, north, up, np.arange(count) * az_step_deg)
    return {
        "version": 1,
        "lat": lat_deg,
        "lon": lon_deg,
        "elev_m": round(elev, 3),
        "mast_m": mast_m,
        "az_step_deg": az_step_deg,
        "skyline_deg": [round(float(v), 4) for v in skyline],
        "skyline_err_deg": [MOCK_SKYLINE_ERR_DEG] * count,
        "dem": [MOCK_DEM_NAME],
        "resolution_m": MOCK_RESOLUTION_M,
        "max_reach_km": MOCK_REACH_KM,
    }


def _patch_coordinates(n: int, spacing_m: float) -> tuple[np.ndarray, np.ndarray]:
    """East and north coordinates of an ``n x n`` grid centred on the site.

    Rows run north to south and columns west to east (shared rules), so row 0
    has the largest north value and column 0 the smallest east value.

    Returns:
        ``(east_m, north_m)``, each of shape ``(n, n)``.
    """
    half = (n - 1) / 2
    east = (np.arange(n) - half) * spacing_m
    north = (half - np.arange(n)) * spacing_m
    return np.meshgrid(east, north)


def terrain_patch(lat_deg: float, lon_deg: float, n: int, spacing_m: float) -> np.ndarray:
    """Mock terrain patch in the Contract 4 layout.

    The value at a grid position is the height of the ground above the site's
    level plane, measured along the site's vertical. On a smooth sphere this
    is negative away from the centre (the ground curves away), which is how
    the Moon's curvature is "included".

    Args:
        lat_deg, lon_deg: the site, degrees.
        n: grid size (odd, so there is a centre sample).
        spacing_m: distance between neighbouring samples, metres.

    Returns:
        Float32 array of shape ``(n, n)``, metres, centre value exactly 0.
    """
    east, north, up = enu_frame(lat_deg, lon_deg)
    origin = (R_MOON_M + height_at(lat_deg, lon_deg)) * up
    e, nn = _patch_coordinates(n, spacing_m)
    base = origin + e[..., None] * east + nn[..., None] * north
    heights = _surface_up_coordinate(base, up).astype(np.float32)
    heights[n // 2, n // 2] = 0.0
    return heights


def shade_grid(lat_deg: float, lon_deg: float, n: int, spacing_m: float,
               az_step_deg: float, mast_m: float) -> tuple[np.ndarray, np.ndarray]:
    """Mock shade grid in the Contract 5 layout.

    For every cell of the patch: its skyline and its surface normal, both
    expressed in the site's east/north/up frame (the frame of the terrain
    patch), not in the cell's own frame.

    Args:
        lat_deg, lon_deg: centre of the patch, degrees.
        n: grid size (odd).
        spacing_m: distance between neighbouring cells, metres.
        az_step_deg: spacing between azimuths, degrees; must divide 360.
        mast_m: eye height above the ground at each cell, metres.

    Returns:
        ``(skyline_deg, normals)``: skylines of shape ``(n, n, n_az)`` in
        degrees, and unit normals of shape ``(n, n, 3)`` as (east, north, up).
    """
    east, north, up = enu_frame(lat_deg, lon_deg)
    origin = (R_MOON_M + height_at(lat_deg, lon_deg)) * up
    e, nn = _patch_coordinates(n, spacing_m)

    def ground(e_m, n_m):
        base = origin + e_m[..., None] * east + n_m[..., None] * north
        return base, _surface_up_coordinate(base, up)

    base, t = ground(e, nn)
    delta = 1.0  # metres; slope by central difference
    slope_e = (ground(e + delta, nn)[1] - ground(e - delta, nn)[1]) / (2 * delta)
    slope_n = (ground(e, nn + delta)[1] - ground(e, nn - delta)[1]) / (2 * delta)
    normals = np.stack([-slope_e, -slope_n, np.ones_like(slope_e)], axis=-1)
    normals /= np.linalg.norm(normals, axis=-1, keepdims=True)

    azimuths = np.arange(int(round(360.0 / az_step_deg))) * az_step_deg
    skylines = np.empty((n, n, len(azimuths)))
    for i in range(n):
        for j in range(n):
            ground_point = base[i, j] + t[i, j] * up
            local_up = ground_point / np.linalg.norm(ground_point)
            skylines[i, j] = skyline_in_frame(
                ground_point + mast_m * local_up, east, north, up, azimuths, n_steps=300)
    return skylines, normals.astype(np.float32)
