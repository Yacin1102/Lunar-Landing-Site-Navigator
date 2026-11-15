"""Terrain patches (Contract 4) and shade grids (Contract 5) from the real maps.

Role
    The 3D view's data. A terrain patch is the shape of the ground around a
    site; a shade grid is a skyline and a surface normal for every cell of a
    square around it, which the browser turns into a lit/dark map for any
    time. Both are for display only: the site's own verdict always comes from
    its full skyline with its error bound (spec sections 8 and 9).

The site's frame, in plain words
    Everything is expressed in the site's local frame: "up" is the site's
    vertical (away from the Moon's centre), "north" is along the site's
    meridian toward the north pole (near the south pole that is the direction
    *away* from the pole), and "east" completes the set. A patch position
    ``(e, n)`` in metres is a point of the site's level plane, the flat plane
    touching the ground at the site. Rows run north to south and columns west
    to east, so row 0 is the northern edge.

    A terrain value is the height of the ground above that plane, measured
    along the site's vertical, found exactly: start on the plane, move along
    the vertical, and correct until the point lies on the map's surface. On a
    smooth sphere this falls away from the centre (by about ``d**2 / 2R``,
    1.7 m at 2.4 km), which is how the Moon's curvature is included. The
    centre value is 0.

Shade grid skylines
    Each cell's skyline is computed by the same proven search as the site
    skylines (:func:`lunar_engine.skyline.compute_skyline`), from the eye
    ``mast_m`` above the cell's ground, at the stored azimuth step. It is
    computed in the cell's own frame and turned into the site's frame
    (interpretation 6). Each cell wedge is carried over as 3D directions (its
    centre and its two edges), and every stored wedge keeps the highest value
    of all the cell wedges that overlap it. Near the pole the two frames'
    "north" directions differ by many degrees, because the meridians
    converge, so a cell wedge usually straddles two stored wedges, and both
    take its value. A stored wedge can then show terrain higher than its own,
    by at most the difference between neighbouring wedges. The edges are
    placed at each wedge's own elevation, and terrain at other elevations in
    the wedge can sit up to ``tilt * |tan e1 - tan e2|`` from them (about
    0.02 degrees at most at these sites).

    The stored value is the middle of the search's proven interval, rounded
    to ``skyline_scale``. The map's height error is not added. That is right
    for a display, and the site's own answer carries it in full.
    ``docs/ACCURACY.md`` lists the remaining error.

Units: metres, degrees.
"""

from __future__ import annotations

import numpy as np

from .elevation import ElevationSource, unit_to_xy
from .geometry import R_MOON_M, az_el_in_frame, enu_frame, lat_lon_radius
from .skyline import compute_skyline

#: Terrain patch: 241 x 241 samples, 20 m apart (a 4.8 km square; the maps under
#: every site have 10 m pixels).
TERRAIN_N, TERRAIN_SPACING_M = 241, 20.0
#: Shade grid: the same 4.8 km square, 17 x 17 cells 300 m apart, 1 degree wedges.
SHADE_N, SHADE_SPACING_M, SHADE_AZ_STEP_DEG = 17, 300.0, 1.0
#: Int16 value * this = degrees (covers +/- 98 degrees).
SHADE_SCALE = 0.003
#: Target half-width of each cell's proven interval, degrees (display precision).
SHADE_TOLERANCE_DEG = 0.01
#: Smallest overlap, in wedges, for a cell wedge to count in a stored wedge.
EDGE_EPS = 1e-6
#: Changes whenever the shade method changes, so saved rows from an older
#: method are never reused (python/scripts/build_products.py).
SHADE_METHOD_VERSION = 2


def patch_coordinates(n: int, spacing_m: float) -> tuple[np.ndarray, np.ndarray]:
    """East and north coordinates of an ``n x n`` grid centred on the site.

    Row 0 has the largest north value, column 0 the smallest east value.

    Returns:
        ``(east_m, north_m)``, each of shape ``(n, n)``.
    """
    half = (n - 1) / 2
    east = (np.arange(n) - half) * spacing_m
    north = (half - np.arange(n)) * spacing_m
    return np.meshgrid(east, north)


class SiteFrame:
    """The site's frame and the exact ground surface seen from it.

    Args:
        source: the terrain.
        lat, lon: the site, degrees.
    """

    def __init__(self, source: ElevationSource, lat: float, lon: float):
        self.source, self.lat, self.lon = source, lat, lon
        self.grid = source.grid_at(lat, lon)
        self.east, self.north, self.up = enu_frame(lat, lon)
        self.elev_m = source.height(lat, lon)
        self.origin = (R_MOON_M + self.elev_m) * self.up

    def _height_at_points(self, points: np.ndarray) -> np.ndarray:
        x, y = unit_to_xy(points / np.linalg.norm(points, axis=-1, keepdims=True))
        h = self.grid.height_xy(x, y).reshape(points.shape[:-1])
        if np.isnan(h).any():
            raise ValueError("the patch leaves the map under the site")
        return h

    def ground(self, e_m: np.ndarray, n_m: np.ndarray, rounds: int = 8) -> tuple[np.ndarray, np.ndarray]:
        """Height above the site's level plane at plane positions, and the ground points.

        Returns:
            ``(t, points)``: ``t`` in metres (shape of ``e_m``), and the ground
            points in metres, ``MOON_ME``, shape ``e_m.shape + (3,)``.
        """
        base = self.origin + np.asarray(e_m)[..., None] * self.east + np.asarray(n_m)[..., None] * self.north
        t = np.zeros(np.shape(e_m))
        for _ in range(rounds):
            point = base + t[..., None] * self.up
            radius = np.linalg.norm(point, axis=-1)
            miss = (R_MOON_M + self._height_at_points(point)) - radius
            t = t + miss / ((point @ self.up) / radius)
        return t, base + t[..., None] * self.up

    def terrain_patch(self, n: int = TERRAIN_N, spacing_m: float = TERRAIN_SPACING_M) -> np.ndarray:
        """Contract 4 heights, shape ``(n, n)``, Float32, metres, centre exactly 0."""
        e, nn = patch_coordinates(n, spacing_m)
        heights = self.ground(e, nn)[0].astype(np.float32)
        heights[n // 2, n // 2] = 0.0
        return heights

    def normals(self, n: int = SHADE_N, spacing_m: float = SHADE_SPACING_M, delta_m: float = 10.0) -> np.ndarray:
        """Unit surface normals ``(east, north, up)`` in the site's frame, shape ``(n, n, 3)``.

        The slope is the central difference of the exact surface across
        ``delta_m`` on each side (one 10 m pixel).
        """
        e, nn = patch_coordinates(n, spacing_m)
        slope_e = (self.ground(e + delta_m, nn)[0] - self.ground(e - delta_m, nn)[0]) / (2 * delta_m)
        slope_n = (self.ground(e, nn + delta_m)[0] - self.ground(e, nn - delta_m)[0]) / (2 * delta_m)
        normals = np.stack([-slope_e, -slope_n, np.ones_like(slope_e)], axis=-1)
        return (normals / np.linalg.norm(normals, axis=-1, keepdims=True)).astype(np.float32)

    def cell_points(self, n: int = SHADE_N, spacing_m: float = SHADE_SPACING_M) -> np.ndarray:
        """Ground points of the shade cells, metres, ``MOON_ME``, shape ``(n, n, 3)``."""
        e, nn = patch_coordinates(n, spacing_m)
        return self.ground(e, nn)[1]


def cell_skyline(source: ElevationSource, frame: SiteFrame, point: np.ndarray, mast_m: float,
                 az_step_deg: float = SHADE_AZ_STEP_DEG,
                 tolerance_deg: float = SHADE_TOLERANCE_DEG) -> np.ndarray:
    """One shade cell's skyline in the site's frame, degrees, ``360 / az_step_deg`` values.

    Args:
        source: the terrain.
        frame: the site's frame.
        point: the cell's ground point, metres, ``MOON_ME``.
        mast_m: eye height above the cell's ground, metres.
    """
    lat, lon, _ = lat_lon_radius(point)
    result = compute_skyline(source, float(lat), float(lon), mast_m, az_step_deg, tolerance_deg=tolerance_deg)
    middle = (np.asarray(result.lower_deg) + np.asarray(result.upper_deg)) / 2
    azimuth = np.radians(np.arange(len(middle)) * az_step_deg)
    elevation = np.radians(middle)
    c_east, c_north, c_up = enu_frame(float(lat), float(lon))
    directions = (np.cos(elevation)[:, None] * (np.sin(azimuth)[:, None] * c_east + np.cos(azimuth)[:, None] * c_north)
                  + np.sin(elevation)[:, None] * c_up)
    site_az, site_el = az_el_in_frame(directions, frame.east, frame.north, frame.up)

    # Where each cell wedge's two edges fall in the site's frame. Near the pole
    # the two "north" directions differ by many degrees (the meridians
    # converge), so a cell wedge can straddle two stored wedges. (A first
    # version assumed it could not; its own check caught the error near the
    # Shackleton rim.) Edges are taken at the wedge's own elevation; terrain at
    # another elevation e in the wedge lands up to tilt * |tan e - tan e_mid|
    # away (about 0.02 degrees at most here; docs/ACCURACY.md).
    def site_azimuth_of(cell_az_deg):
        a = np.radians(cell_az_deg)
        d = (np.cos(elevation)[:, None] * (np.sin(a)[:, None] * c_east + np.cos(a)[:, None] * c_north)
             + np.sin(elevation)[:, None] * c_up)
        return az_el_in_frame(d, frame.east, frame.north, frame.up)[0]

    centre = np.arange(len(middle)) * az_step_deg
    behind = (site_az - site_azimuth_of(centre - az_step_deg / 2) + 180.0) % 360.0 - 180.0
    ahead = (site_azimuth_of(centre + az_step_deg / 2) - site_az + 180.0) % 360.0 - 180.0
    lo = (site_az - behind) / az_step_deg                  # in units of stored wedges
    hi = (site_az + ahead) / az_step_deg
    # Stored wedge k spans k - 0.5 .. k + 0.5. It takes a cell wedge's value only
    # when they truly overlap, by more than EDGE_EPS of a wedge: wedges that
    # merely touch at an edge do not count. (A first version added a margin
    # here, which made every stored wedge the highest of three; found by review.)
    first = np.floor(lo - 0.5 + EDGE_EPS).astype(int) + 1
    last = np.ceil(hi + 0.5 - EDGE_EPS).astype(int) - 1
    n_az = int(round(360 / az_step_deg))
    out = np.full(n_az, -np.inf)
    for offset in range(int((last - first).max()) + 1):
        k = first + offset
        inside = k <= last
        np.maximum.at(out, k[inside] % n_az, site_el[inside])
    if not np.isfinite(out).all():
        raise RuntimeError("a stored wedge received no value")
    return out
