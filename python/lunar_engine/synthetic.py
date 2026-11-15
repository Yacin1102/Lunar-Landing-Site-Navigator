"""Synthetic terrain: shapes given by formulas, sampled onto map grids.

Role
    The second backend of :class:`lunar_engine.elevation.ElevationSource`.
    It lets the skyline engine, its stopping rule, its error bound, the
    line-of-sight check, the record writer and the live API be built and
    tested without the real maps, and against answers that can be worked out
    by hand (spec section 13: "the skyline is right on synthetic terrain with
    hand-calculated answers").

How it works, in plain words
    The ground is the reference sphere plus a list of shapes (cones, domes,
    walls). Each shape is a formula giving its height at any point. To make a
    map, the formula is evaluated at the centre of every pixel of a grid in
    the same polar projection as the real maps. From then on the grid is used
    exactly like a real one, so the engine runs the same code on both.

    The formulas stay available as :meth:`SyntheticElevation.true_height`,
    for tests that compare the sampled map with the exact shape.

Units: metres and degrees; see :mod:`lunar_engine.elevation`.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .elevation import ElevationSource, GridSpec, HeightGrid, to_xy, xy_to_unit
from .geometry import R_MOON_M, enu_frame, unit_vector

SYNTHETIC_NAME = "SYNTHETIC"


def _surface_distance_m(directions: np.ndarray, lat_deg: float, lon_deg: float) -> np.ndarray:
    """Exact distance along the sphere from a centre to each direction, metres."""
    chord = np.linalg.norm(directions - unit_vector(lat_deg, lon_deg), axis=-1)
    return 2.0 * R_MOON_M * np.arcsin(np.clip(chord / 2.0, 0.0, 1.0))


@dataclass(frozen=True)
class Cone:
    """A straight-sided cone: full height at the centre, zero at the base radius.

    Attributes:
        lat, lon: centre, degrees.
        base_radius_m: distance along the surface at which it reaches zero.
        height_m: height at the centre, metres.
    """

    lat: float
    lon: float
    base_radius_m: float
    height_m: float

    def height(self, directions: np.ndarray) -> np.ndarray:
        r = _surface_distance_m(directions, self.lat, self.lon)
        return self.height_m * np.clip(1.0 - r / self.base_radius_m, 0.0, None)


@dataclass(frozen=True)
class Dome:
    """A smooth round hill (or hollow, if negative): ``height * exp(-(r / radius)^2)``.

    Attributes:
        lat, lon: centre, degrees.
        radius_m: distance along the surface at which it has fallen to 37 %.
        height_m: height at the centre, metres.
    """

    lat: float
    lon: float
    radius_m: float
    height_m: float

    def height(self, directions: np.ndarray) -> np.ndarray:
        r = _surface_distance_m(directions, self.lat, self.lon)
        return self.height_m * np.exp(-(r / self.radius_m) ** 2)


@dataclass(frozen=True)
class RingWall:
    """A flat-topped wall along part of a circle around a centre point.

    Seen from the centre, the wall's near face is at the same distance in
    every direction it covers, so its skyline can be worked out by hand.

    Attributes:
        lat, lon: centre of the circle, degrees.
        radius_m: distance along the surface from the centre to the near face.
        thickness_m: how far the wall extends beyond the near face.
        height_m: height of the flat top, metres.
        az_from_deg, az_to_deg: the wall exists between these azimuths seen
            from the centre (degrees from north, clockwise, going clockwise
            from the first to the second). The default is the full circle.
    """

    lat: float
    lon: float
    radius_m: float
    thickness_m: float
    height_m: float
    az_from_deg: float = 0.0
    az_to_deg: float = 360.0

    def height(self, directions: np.ndarray) -> np.ndarray:
        r = _surface_distance_m(directions, self.lat, self.lon)
        inside = (r >= self.radius_m) & (r <= self.radius_m + self.thickness_m)
        span = (self.az_to_deg - self.az_from_deg) % 360.0
        if span != 0.0 or self.az_to_deg == self.az_from_deg:
            east, north, _ = enu_frame(self.lat, self.lon)
            azimuth = np.degrees(np.arctan2(directions @ east, directions @ north))
            inside &= ((azimuth - self.az_from_deg) % 360.0) <= span
        return np.where(inside, self.height_m, 0.0)


class SyntheticElevation(ElevationSource):
    """Terrain made of shapes on a sphere, sampled onto one or more grids.

    Args:
        shapes: the shapes; their heights add up.
        grids: list of ``(pixel_m, half_width_m)``: for each, a square grid of
            that pixel size reaching ``half_width_m`` either side of
            ``center``. Give several for nested maps of different detail.
        center: ``(lat, lon)`` of the middle of the grids, degrees. The grids
            are shifted by less than a pixel so that pixel edges fall on whole
            multiples of the pixel size, as in the real maps.
        base_height_m: height of the ground where there is no shape, metres.
        error_m: height error written into every pixel of the error maps,
            metres, or ``None`` for grids without an error map.
        beyond_maps_height_m: the most terrain outside the grids could rise,
            metres. ``None`` keeps the real-data assumption (unknown terrain
            up to 11,000 m), so a search that needs to look past the grids
            fails. Giving ``base_height_m`` declares that beyond the grids
            the Moon is the smooth base sphere: for synthetic worlds only.
    """

    is_real = False

    def __init__(self, shapes, grids=((20.0, 20_000.0),), center=(-90.0, 0.0),
                 base_height_m: float = 0.0, error_m: float | None = 1.0,
                 beyond_maps_height_m: float | None = None):
        if beyond_maps_height_m is not None:
            self.unknown_height_m = float(beyond_maps_height_m)
        self.shapes = tuple(shapes)
        self.base_height_m = float(base_height_m)
        cx, cy = (float(v) for v in to_xy(*center))
        built = []
        for pixel_m, half_width_m in grids:
            n = 2 * int(round(half_width_m / pixel_m))
            x_left = (np.round(cx / pixel_m) - n // 2) * pixel_m
            y_top = (np.round(cy / pixel_m) + n // 2) * pixel_m
            spec = GridSpec(float(pixel_m), float(x_left), float(y_top), n, n)
            heights = np.empty((n, n), dtype=np.float32)
            x = spec.x_of_col(np.arange(n))
            for start in range(0, n, 256):                    # limit memory
                y = spec.y_of_row(np.arange(start, min(start + 256, n)))
                directions = xy_to_unit(x[None, :], y[:, None])
                heights[start:start + 256] = self._true_height(directions)
            errors = None if error_m is None else np.full((n, n), error_m, dtype=np.float32)
            built.append(HeightGrid(f"{SYNTHETIC_NAME}_{pixel_m:g}MPP", spec, heights, errors))
        super().__init__(built)

    def _true_height(self, directions: np.ndarray) -> np.ndarray:
        total = np.full(directions.shape[:-1], self.base_height_m)
        for shape in self.shapes:
            total = total + shape.height(directions)
        return total

    def true_height(self, lat_deg, lon_deg) -> np.ndarray:
        """Height of the exact shapes at a point, metres (not the sampled map)."""
        return self._true_height(unit_vector(lat_deg, lon_deg))
