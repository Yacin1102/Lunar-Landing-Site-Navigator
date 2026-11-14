"""Terrain heights behind one interface, for real maps and for synthetic terrain.

Role
    Everything that needs the shape of the ground (skylines, terrain patches,
    shade grids, the live API) asks an :class:`ElevationSource`. It does not
    know or care whether the heights came from NASA's LOLA maps or from
    shapes given by formulas. This is what lets the skyline engine be built
    and proven on synthetic terrain while the real maps are still downloading
    (spec sections 3 and 7).

How terrain is stored, in plain words
    A map is a square grid of heights in the **south polar stereographic
    projection**: imagine the polar region pressed flat onto a sheet touching
    the Moon at the south pole. A position on the sheet is ``(x, y)`` in
    metres from the pole; longitude 0 is toward ``+y`` and longitude 90 east
    toward ``+x``. This is the projection of the LOLA polar maps, with true
    scale at the pole.

    A grid value is the height at the centre of its pixel. Between pixel
    centres the ground is taken to be the smooth "bilinear" blend of the four
    surrounding values. That blended surface is the terrain: every height,
    every skyline and every error figure refers to it.

    An :class:`ElevationSource` holds one or more grids of different pixel
    sizes covering nested areas, and always answers from the finest grid that
    covers the point asked for.

Conventions (shared rules)
    Heights in metres above the sphere of radius 1737.4 km. Latitude and
    longitude in degrees, east positive, -180 to 180. Inside a grid array,
    row 0 is the edge with the largest ``y`` and column 0 the edge with the
    smallest ``x`` (the layout of the map files). Missing data is NaN.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .geometry import R_MOON_M, wrap_lon


class CoverageError(Exception):
    """A height was needed where the elevation data has none."""


# --------------------------------------------------------------------------
# South polar stereographic projection (exact, on the sphere)
# --------------------------------------------------------------------------

def to_xy(lat_deg, lon_deg) -> tuple[np.ndarray, np.ndarray]:
    """Latitude/longitude to projected ``(x, y)`` in metres.

    South polar stereographic on the 1737.4 km sphere, true scale at the
    pole, central meridian 0: the distance from the pole on the sheet is
    ``2 R tan((90 + lat) / 2)``, ``x = distance * sin(lon)`` and
    ``y = distance * cos(lon)``.
    """
    lat = np.radians(np.asarray(lat_deg, dtype=float))
    lon = np.radians(np.asarray(lon_deg, dtype=float))
    rho = 2.0 * R_MOON_M * np.tan((np.pi / 2 + lat) / 2)
    return rho * np.sin(lon), rho * np.cos(lon)


def to_lat_lon(x_m, y_m) -> tuple[np.ndarray, np.ndarray]:
    """Projected ``(x, y)`` in metres to latitude/longitude in degrees.

    Longitude is returned in -180 (included) to 180 (excluded). At the pole
    itself (0, 0) the longitude is 0.
    """
    x = np.asarray(x_m, dtype=float)
    y = np.asarray(y_m, dtype=float)
    rho = np.hypot(x, y)
    lat = np.degrees(2.0 * np.arctan(rho / (2.0 * R_MOON_M))) - 90.0
    lon = wrap_lon(np.degrees(np.arctan2(x, y)))
    return lat, lon


def xy_to_unit(x_m, y_m) -> np.ndarray:
    """Projected ``(x, y)`` straight to a direction from the Moon's centre.

    Returns:
        Unit vectors of shape ``(..., 3)`` in ``MOON_ME``. No trigonometry is
        involved, so there is no loss of precision near the pole.
    """
    x = np.asarray(x_m, dtype=float)
    y = np.asarray(y_m, dtype=float)
    four_r2 = 4.0 * R_MOON_M ** 2
    denominator = four_r2 + x ** 2 + y ** 2
    return np.stack([4.0 * R_MOON_M * y / denominator,
                     4.0 * R_MOON_M * x / denominator,
                     -(four_r2 - x ** 2 - y ** 2) / denominator], axis=-1)


def scale_factor(lat_deg) -> np.ndarray:
    """How much the projection stretches distances at a latitude.

    A short distance ``d`` on the Moon is drawn ``scale_factor * d`` long on
    the sheet. It is exactly 1 at the south pole and grows away from it
    (1.0038 at 83 S, 1.072 at 60 S), never below 1. So two points are never
    farther apart on the Moon than they are on the sheet: a fact the skyline
    search relies on for its guarantees.
    """
    lat = np.radians(np.asarray(lat_deg, dtype=float))
    return 2.0 / (1.0 - np.sin(lat))


# --------------------------------------------------------------------------
# One map
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class GridSpec:
    """Where a grid sits on the projected sheet.

    Attributes:
        pixel_m: pixel size, metres.
        x_left: ``x`` of the left edge of column 0, metres.
        y_top: ``y`` of the top edge of row 0, metres.
        n_rows, n_cols: grid size in pixels.
    """

    pixel_m: float
    x_left: float
    y_top: float
    n_rows: int
    n_cols: int

    def x_of_col(self, col):
        """``x`` of the centre of a column (fractional columns allowed), metres."""
        return self.x_left + (np.asarray(col, dtype=float) + 0.5) * self.pixel_m

    def y_of_row(self, row):
        """``y`` of the centre of a row (fractional rows allowed), metres."""
        return self.y_top - (np.asarray(row, dtype=float) + 0.5) * self.pixel_m

    def col_of_x(self, x_m):
        """Fractional column whose centre is at ``x`` (0.0 = centre of column 0)."""
        return (np.asarray(x_m, dtype=float) - self.x_left) / self.pixel_m - 0.5

    def row_of_y(self, y_m):
        """Fractional row whose centre is at ``y`` (0.0 = centre of row 0)."""
        return (self.y_top - np.asarray(y_m, dtype=float)) / self.pixel_m - 0.5

    def covers(self, x_m, y_m):
        """True where a height can be interpolated: inside the pixel centres."""
        col, row = self.col_of_x(x_m), self.row_of_y(y_m)
        return (col >= 0) & (col <= self.n_cols - 1) & (row >= 0) & (row <= self.n_rows - 1)


class HeightGrid:
    """One elevation map: heights, and optionally their published error.

    This base class keeps everything in memory, which suits synthetic terrain
    and tests. The reader for the real map files provides the same methods
    but fetches pieces of the file as they are asked for.

    Args:
        name: the map's name, as reported in the ``dem`` field of products.
        spec: where the grid sits on the projected sheet.
        heights: array ``(n_rows, n_cols)``, metres above the sphere, NaN
            where there is no data.
        errors: array of the same shape with the height error of each pixel,
            metres, or ``None`` if the map has none.
    """

    def __init__(self, name: str, spec: GridSpec, heights: np.ndarray,
                 errors: np.ndarray | None = None):
        heights = np.asarray(heights, dtype=np.float32)
        if heights.shape != (spec.n_rows, spec.n_cols):
            raise ValueError(f"heights have shape {heights.shape}, the grid says "
                             f"{(spec.n_rows, spec.n_cols)}")
        if errors is not None and np.shape(errors) != heights.shape:
            raise ValueError("errors must have the same shape as heights")
        self.name = name
        self.spec = spec
        self._heights = heights
        self._errors = None if errors is None else np.asarray(errors, dtype=np.float32)

    def read(self, row0: int, row1: int, col0: int, col1: int) -> np.ndarray:
        """Heights of rows ``row0..row1-1`` and columns ``col0..col1-1``, metres."""
        return self._heights[row0:row1, col0:col1]

    def read_error(self, row0: int, row1: int, col0: int, col1: int) -> np.ndarray | None:
        """Height errors of the same window, metres, or ``None`` if not available."""
        return None if self._errors is None else self._errors[row0:row1, col0:col1]

    def _interpolate(self, reader, x_m, y_m) -> np.ndarray:
        """Bilinear blend of the four pixel centres around each point.

        Returns NaN where the point is outside the pixel centres or where any
        of the four values is missing.
        """
        x = np.atleast_1d(np.asarray(x_m, dtype=float))
        y = np.atleast_1d(np.asarray(y_m, dtype=float))
        out = np.full(x.shape, np.nan)
        inside = self.spec.covers(x, y)
        if not inside.any():
            return out
        col = self.spec.col_of_x(x[inside])
        row = self.spec.row_of_y(y[inside])
        c0 = np.minimum(np.floor(col).astype(int), self.spec.n_cols - 2)
        r0 = np.minimum(np.floor(row).astype(int), self.spec.n_rows - 2)
        fc, fr = col - c0, row - r0
        rmin, rmax, cmin, cmax = r0.min(), r0.max() + 2, c0.min(), c0.max() + 2
        window = reader(rmin, rmax, cmin, cmax)
        if window is None:
            return out
        window = np.asarray(window, dtype=float)
        r, c = r0 - rmin, c0 - cmin
        out[inside] = (window[r, c] * (1 - fr) * (1 - fc) + window[r, c + 1] * (1 - fr) * fc
                       + window[r + 1, c] * fr * (1 - fc) + window[r + 1, c + 1] * fr * fc)
        return out

    def height_xy(self, x_m, y_m) -> np.ndarray:
        """Interpolated height at projected points, metres; NaN where unavailable."""
        return self._interpolate(self.read, x_m, y_m)

    def error_xy(self, x_m, y_m) -> np.ndarray:
        """Interpolated height error at projected points, metres; NaN where unavailable."""
        return self._interpolate(self.read_error, x_m, y_m)


def cell_max(heights: np.ndarray) -> np.ndarray:
    """Highest corner of every cell between pixel centres.

    A "cell" is the square between four neighbouring pixel centres. Because
    the ground inside it is a blend of its four corners, it is nowhere higher
    than the highest corner. A cell with a missing corner gets NaN.

    Args:
        heights: array ``(n_rows, n_cols)``.

    Returns:
        Array ``(n_rows - 1, n_cols - 1)``.
    """
    h = np.asarray(heights, dtype=float)
    return np.maximum(np.maximum(h[:-1, :-1], h[:-1, 1:]), np.maximum(h[1:, :-1], h[1:, 1:]))


def max_pyramid(cells: np.ndarray, missing_as: float) -> list[np.ndarray]:
    """Tables of "the highest terrain in this block" at ever coarser block sizes.

    Level 0 is ``cells`` itself. Each next level halves the resolution: one
    value is the maximum of the 2 x 2 values beneath it (edges are padded).
    The last level is a single value: the highest terrain of the whole map.
    Missing cells count as ``missing_as`` so that a block containing unknown
    terrain is never assumed to be low.

    Args:
        cells: array from :func:`cell_max`.
        missing_as: height assumed for missing cells, metres.

    Returns:
        List of arrays, finest first. ``levels[k][i, j]`` is an upper limit
        for every cell ``levels[0][i*2**k : (i+1)*2**k, j*2**k : (j+1)*2**k]``.
    """
    level = np.where(np.isnan(cells), missing_as, cells).astype(float)
    levels = [level]
    while level.shape != (1, 1):
        rows, cols = level.shape
        padded = np.full((rows + rows % 2, cols + cols % 2), -np.inf)
        padded[:rows, :cols] = level
        level = padded.reshape(padded.shape[0] // 2, 2, padded.shape[1] // 2, 2).max(axis=(1, 3))
        levels.append(level)
    return levels


# --------------------------------------------------------------------------
# Several maps behind one interface
# --------------------------------------------------------------------------

class ElevationSource:
    """Terrain heights from one or more nested maps.

    Args:
        grids: the maps, in any order. They are kept finest first, and every
            question is answered from the finest map that covers the point.

    Attributes:
        grids: the maps, finest pixel first.
        is_real: False for synthetic terrain. Products built from a source
            with ``is_real`` False must be marked as not real.
    """

    is_real = True

    def __init__(self, grids: list[HeightGrid]):
        if not grids:
            raise ValueError("an elevation source needs at least one grid")
        self.grids = sorted(grids, key=lambda g: g.spec.pixel_m)

    @property
    def names(self) -> list[str]:
        """Names of the maps, finest first (the ``dem`` field of products)."""
        return [grid.name for grid in self.grids]

    def grid_at(self, lat_deg: float, lon_deg: float) -> HeightGrid:
        """The finest map covering a point.

        Raises:
            CoverageError: if no map covers it.
        """
        x, y = to_xy(lat_deg, lon_deg)
        for grid in self.grids:
            if bool(grid.spec.covers(x, y)):
                return grid
        raise CoverageError(f"no elevation data at latitude {lat_deg}, longitude {lon_deg}")

    def resolution_at(self, lat_deg: float, lon_deg: float) -> float:
        """Pixel size of the finest map covering a point, metres."""
        return self.grid_at(lat_deg, lon_deg).spec.pixel_m

    def height(self, lat_deg: float, lon_deg: float) -> float:
        """Ground height at a point, metres above the 1737.4 km sphere.

        Raises:
            CoverageError: if the point is outside every map or in a hole of
                the finest map covering it. A height is never guessed.
        """
        x, y = to_xy(lat_deg, lon_deg)
        value = float(self.grid_at(lat_deg, lon_deg).height_xy(x, y)[0])
        if np.isnan(value):
            raise CoverageError(f"elevation data is missing at latitude {lat_deg}, "
                                f"longitude {lon_deg}")
        return value

    def height_error(self, lat_deg: float, lon_deg: float) -> float | None:
        """Published height error at a point, metres, or ``None`` if the map has none."""
        x, y = to_xy(lat_deg, lon_deg)
        grid = self.grid_at(lat_deg, lon_deg)
        if grid.read_error(0, 1, 0, 1) is None:
            return None
        value = float(grid.error_xy(x, y)[0])
        if np.isnan(value):
            raise CoverageError(f"height error is missing at latitude {lat_deg}, "
                                f"longitude {lon_deg}")
        return value

    def service_lat_max(self) -> float:
        """Northernmost latitude at which every longitude is inside the data.

        The maps are squares on the projected sheet; the largest circle
        around the pole that fits inside the widest map gives the latitude
        up to which all longitudes are covered. Returns degrees.
        """
        spec = self.grids[-1].spec
        half = spec.pixel_m / 2
        reach = min(-(spec.x_left + half), spec.x_left + spec.n_cols * spec.pixel_m - half,
                    spec.y_top - half, -(spec.y_top - spec.n_rows * spec.pixel_m + half))
        return float(to_lat_lon(reach, 0.0)[0])
