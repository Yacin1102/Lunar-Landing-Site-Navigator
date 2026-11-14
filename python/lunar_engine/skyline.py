"""The skyline: how high the terrain rises above the level horizon, in every direction.

Role
    The most important calculation of the project (spec section 7). For an
    observer's eye at a point, and for every azimuth wedge, it finds the
    highest elevation angle at which terrain appears. The Sun or the Earth is
    hidden in a direction when it is below the skyline there.

    It works on any :class:`lunar_engine.elevation.ElevationSource`, real or
    synthetic, and is shared by the Builder and the live API.

What exactly is computed
    * Wedges: entry ``k`` covers azimuths from ``(k - 1/2) * step`` up to
      (not including) ``(k + 1/2) * step``, measured from north, clockwise.
    * The terrain is the surface defined in :mod:`lunar_engine.elevation`:
      bilinear between pixel centres of the finest trusted map at each point.
    * Elevation angle is measured from the eye, above the eye's level plane
      (perpendicular to the line from the Moon's centre, the true local
      vertical of the reference sphere). All geometry is exact 3D geometry on
      the sphere; there is no flat-ground or small-angle formula anywhere.
    * The ground within 1 m of the point under the eye is not counted as an
      obstacle (``EXCLUDE_RADIUS_M``).

    For every wedge the result is a **guaranteed interval**: ``lower`` is the
    elevation of an actual terrain point in the wedge, so the true maximum is
    at least that; ``upper`` is a proven ceiling that no terrain point in the
    wedge, at any distance, can exceed. The skyline reported is the middle of
    the interval and half its width is the numerical part of the error bound.

How it works, in plain words
    1. **Quick first look.** Along the centre line of every wedge, the
       terrain is sampled outward from the observer. Every sample is a real
       terrain point, so it gives a first ``lower`` for its wedge.
    2. **Proving areas cannot matter.** Each map is divided into blocks: the
       whole map, then quarters, then quarters of those, down to single
       cells. For each block the map's "highest terrain in this block" table
       gives its highest possible point. From that and from the block's
       nearest possible distance, a ceiling on the elevation angle any part
       of the block could have is worked out, together with the range of
       azimuths the block could cover. If the ceiling is not above what has
       already been seen in every one of those azimuths, nothing in the
       block can raise the skyline and the whole block is set aside with
       proof. Otherwise its four quarters are examined the same way.
    3. **Cells near the skyline.** Single cells that survive are cut into
       quarters again and again (the ground inside each piece is still the
       exact blend of the cell's four corners), sampling the corners as
       real terrain points, until each piece is either proven unable to
       matter, or its ceiling is within ``tolerance_deg`` of what has been
       seen, or ``max_depth`` cuts have been made. Pieces still open then
       widen the interval honestly instead of being dropped.
    4. **The edge of the data.** Terrain beyond every map is unknown, so it
       is assumed to be as high as anything on the Moon. If even that cannot
       rise above what has been seen in any direction, the search is
       complete. If it could, the calculation stops with
       :class:`~lunar_engine.elevation.CoverageError`: there is no cut-off
       distance and no guess.

Why no peak can be missed
    The ceilings are proven, not estimated:

    * Heights: the ground inside a cell never exceeds its highest corner, and
      the tables hold the maximum of those corners over every block.
    * Distances: a block is a rectangle on the projected sheet. Distances on
      the sphere are never longer than on the sheet, so the whole block lies
      within a circle on the sphere (a "cap") around the block's centre whose
      radius is half the rectangle's diagonal.
    * Angles: for terrain at a given height, the elevation angle seen from
      the eye first rises with distance (until the line of sight would graze
      a sphere through that height) and then falls. So over a range of
      distances its maximum is at a known point of that range.
    * Azimuths: the azimuths a cap covers, seen from the eye, are exactly the
      cap centre's azimuth plus or minus ``asin(sin(radius) / sin(distance))``.
      Azimuth does not depend on height, because the eye is on the vertical.

Units: degrees, metres; ``MOON_ME``; see :mod:`lunar_engine.geometry`.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np

from .elevation import CoverageError, ElevationSource, to_xy, unit_to_xy, xy_to_unit
from .geometry import R_MOON_M, enu_frame

#: Ground closer than this to the point under the eye is not an obstacle, metres.
EXCLUDE_RADIUS_M = 1.0
#: A piece of terrain is not cut further once its ceiling is within this of
#: what has been seen in its wedges, degrees. Sets the numerical error.
TOLERANCE_DEG = 0.0005
#: Most times a single cell is cut into quarters (1/256 of a pixel at 8).
MAX_DEPTH = 8
#: First-look samples along a wedge's centre line are at most this many
#: wedge widths of arc apart, and never closer than one pixel.
SEED_SPACING_WEDGES = 4.0


def wedge_count(az_step_deg: float) -> int:
    """Number of azimuth entries for a step; the step must divide 360 exactly.

    >>> wedge_count(0.1), wedge_count(1.0)
    (3600, 360)
    """
    count = 360.0 / float(az_step_deg)
    n = int(round(count))
    if not az_step_deg > 0 or n < 1 or abs(count - n) > 1e-9:
        raise ValueError(f"az_step_deg {az_step_deg} does not divide 360 degrees into whole wedges")
    return n


@dataclass
class SkylineResult:
    """A skyline with its guaranteed interval.

    Attributes:
        lat, lon: the point, degrees.
        elev_m: ground height at the point, metres above the 1737.4 km sphere.
        mast_m: eye height above the ground, metres.
        az_step_deg: wedge width, degrees.
        lower_deg: per wedge, the elevation of a real terrain point in it.
        upper_deg: per wedge, a proven ceiling for all terrain in it.
        max_reach_km: distance to the farthest cell that had to be examined
            one by one (everything farther was set aside with proof), km.
        dem: names of the maps searched, finest first.
        resolution_m: pixel size of the map at the point, metres.
        stats: counts and timing, for reports.
    """

    lat: float
    lon: float
    elev_m: float
    mast_m: float
    az_step_deg: float
    lower_deg: np.ndarray
    upper_deg: np.ndarray
    max_reach_km: float
    dem: list[str]
    resolution_m: float
    stats: dict = field(default_factory=dict)

    @property
    def skyline_deg(self) -> np.ndarray:
        """The reported skyline: middle of the guaranteed interval, degrees."""
        return (self.lower_deg + self.upper_deg) / 2.0

    @property
    def numerical_err_deg(self) -> np.ndarray:
        """Half the width of the guaranteed interval, degrees."""
        return (self.upper_deg - self.lower_deg) / 2.0


class _CircularRangeMin:
    """Smallest value over runs of neighbouring entries of a circular array.

    Answers "the smallest ``values[start .. start + count - 1]``, wrapping
    round" for many runs at once, using a table of minima over runs of
    length 1, 2, 4, 8, ... (any run is covered by two overlapping table runs).
    """

    def __init__(self, values: np.ndarray):
        self.n = len(values)
        self.global_min = float(values.min())
        level = np.concatenate([values, values])
        self.levels = [level]
        width = 1
        while 2 * width <= self.n:
            level = np.minimum(level[:-width], level[width:])
            self.levels.append(level)
            width *= 2

    def query(self, start: np.ndarray, count: np.ndarray) -> np.ndarray:
        start = np.asarray(start, dtype=np.int64) % self.n
        count = np.asarray(count, dtype=np.int64)
        out = np.full(start.shape, self.global_min)
        part = count < self.n
        if part.any():
            s, c = start[part], count[part]
            j = np.floor(np.log2(c)).astype(int)
            result = np.empty(len(s))
            for level_index in np.unique(j):
                m = j == level_index
                table = self.levels[level_index]
                result[m] = np.minimum(table[s[m]], table[s[m] + c[m] - (1 << level_index)])
            out[part] = result
        return out


class _Search:
    """One skyline calculation. See the module docstring for the method."""

    def __init__(self, source: ElevationSource, lat: float, lon: float, mast_m: float,
                 az_step_deg: float, tolerance_deg: float, max_depth: int):
        self.source = source
        self.lat, self.lon = lat, lon
        self.step = float(az_step_deg)
        self.n = wedge_count(az_step_deg)
        self.tol = float(tolerance_deg)
        self.max_depth = int(max_depth)
        self.east, self.north, self.up = enu_frame(lat, lon)
        self.elev_m = source.height(lat, lon)
        self.mast_m = mast_m
        self.eye_radius = R_MOON_M + self.elev_m + mast_m
        self.eye = self.eye_radius * self.up
        self.theta_excl = EXCLUDE_RADIUS_M / R_MOON_M
        self.chord_excl = 2.0 * np.sin(self.theta_excl / 2.0)
        self.lower = np.full(self.n, -90.0)
        self.discs = [grid.disc() for grid in source.grids]
        self.final_el: list[np.ndarray] = []
        self.final_start: list[np.ndarray] = []
        self.final_count: list[np.ndarray] = []
        self.reach_theta = 0.0
        self.stats = {"blocks": 0, "cells": 0, "pieces": 0, "samples": 0,
                      "pieces_at_max_depth": 0}

    # ---- geometry ---------------------------------------------------------

    def _chord(self, u: np.ndarray) -> np.ndarray:
        """Straight-line distance between the site and directions ``u`` on the unit sphere."""
        d = u - self.up
        return np.sqrt(np.einsum("...i,...i->...", d, d))

    def _angle_from_site(self, u: np.ndarray) -> np.ndarray:
        """Angle at the Moon's centre between the site and directions ``u``, radians."""
        return 2.0 * np.arcsin(np.clip(self._chord(u) / 2.0, 0.0, 1.0))

    def _elevation_ceiling(self, theta_lo, theta_hi, h_max) -> np.ndarray:
        """Highest elevation angle of any terrain up to ``h_max`` metres high
        at angular distances between ``theta_lo`` and ``theta_hi`` radians, degrees.

        For terrain at radius ``r`` seen from the eye at radius ``re``, with
        ``t`` the angle at the Moon's centre: ``tan(el) = (r cos t - re) /
        (r sin t)``. This grows with ``r`` (higher terrain looks higher) and,
        as ``t`` grows, rises until ``cos t = r / re`` and then falls, so its
        maximum over the range is at that point, clamped into the range.
        """
        r = R_MOON_M + np.asarray(h_max, dtype=float)
        t_star = np.arccos(np.clip(r / self.eye_radius, -1.0, 1.0))
        t = np.minimum(np.maximum(t_star, theta_lo), theta_hi)
        return np.degrees(np.arctan2(r * np.cos(t) - self.eye_radius, r * np.sin(t)))

    def _wedge_of(self, az_deg: np.ndarray) -> np.ndarray:
        return np.floor((az_deg + self.step / 2.0) / self.step).astype(np.int64) % self.n

    def _ceilings(self, cx, cy, half_diag_m, h_max):
        """Ceiling and wedge range for rectangles on the sheet.

        Args:
            cx, cy: rectangle centres, metres on the sheet.
            half_diag_m: half the rectangle diagonals, metres.
            h_max: highest terrain inside each, metres.

        Returns:
            ``(ceiling_deg, first_wedge, wedge_count, theta_centre)``.
        """
        uc = xy_to_unit(cx, cy)
        theta_c = self._angle_from_site(uc)
        rho = half_diag_m / R_MOON_M + 1e-12
        theta_lo = np.maximum(theta_c - rho, self.theta_excl)
        theta_hi = np.minimum(theta_c + rho, np.pi)
        ceiling = self._elevation_ceiling(theta_lo, theta_hi, h_max)
        ceiling = np.where(theta_hi < self.theta_excl, -90.0, ceiling)

        az_c = np.degrees(np.arctan2(uc @ self.east, uc @ self.north))
        ratio = np.sin(rho) / np.maximum(np.sin(theta_c), 1e-300)
        everywhere = (theta_c <= rho) | (ratio >= 1.0)
        delta = np.where(everywhere, 180.0,
                         np.degrees(np.arcsin(np.clip(ratio, 0.0, 1.0))) + 1e-7)
        first = np.floor((az_c - delta + self.step / 2.0) / self.step).astype(np.int64)
        last = np.floor((az_c + delta + self.step / 2.0) / self.step).astype(np.int64)
        count = np.where(everywhere, self.n, np.minimum(last - first + 1, self.n))
        return ceiling, first, count, theta_c

    # ---- which map is responsible where ------------------------------------

    def _responsible(self, x, y, gi: int) -> np.ndarray:
        """True for points whose terrain comes from map ``gi``."""
        cx, cy, r = self.discs[gi]
        ok = np.hypot(x - cx, y - cy) <= r
        for fx, fy, fr in self.discs[:gi]:
            ok &= np.hypot(x - fx, y - fy) > fr
        return ok

    def _rect_relevant(self, xmin, xmax, ymin, ymax, gi: int) -> np.ndarray:
        """False for rectangles wholly outside map ``gi``'s disc or wholly inside a finer one."""
        cx, cy, r = self.discs[gi]
        keep = np.hypot(np.clip(cx, xmin, xmax) - cx, np.clip(cy, ymin, ymax) - cy) <= r
        for fx, fy, fr in self.discs[:gi]:
            far_x = np.maximum(np.abs(xmin - fx), np.abs(xmax - fx))
            far_y = np.maximum(np.abs(ymin - fy), np.abs(ymax - fy))
            keep &= np.hypot(far_x, far_y) > fr
        return keep

    # ---- lower limits from real terrain points ------------------------------

    def _add_samples(self, x, y, h, gi: int) -> None:
        """Raise ``lower`` with terrain points that map ``gi`` is responsible for."""
        x, y, h = np.ravel(x), np.ravel(y), np.ravel(h)
        ok = np.isfinite(h) & self._responsible(x, y, gi)
        if not ok.any():
            return
        u = xy_to_unit(x[ok], y[ok])
        d = (R_MOON_M + h[ok])[:, None] * u - self.eye
        de, dn, du = d @ self.east, d @ self.north, d @ self.up
        keep = self._chord(u) >= self.chord_excl
        el = np.degrees(np.arctan2(du, np.hypot(de, dn)))[keep]
        az = np.degrees(np.arctan2(de, dn))[keep]
        np.maximum.at(self.lower, self._wedge_of(az), el)
        self.stats["samples"] += int(keep.sum())

    def _seed(self, gi: int) -> None:
        """Step 1: sample along every wedge's centre line, within map ``gi``."""
        grid = self.source.grids[gi]
        pixel = grid.spec.pixel_m
        cx, cy, radius = self.discs[gi]
        centre_u = xy_to_unit(cx, cy)
        far_m = (float(self._angle_from_site(centre_u)) + radius / R_MOON_M) * R_MOON_M
        spacing = SEED_SPACING_WEDGES * np.radians(self.step)
        distances = []
        s = max(1.5 * EXCLUDE_RADIUS_M, pixel / 2.0)
        while s <= far_m:
            distances.append(s)
            s += max(pixel, s * spacing)
        t = np.array(distances) / R_MOON_M
        azimuths = np.radians(np.arange(self.n) * self.step)
        for start in range(0, self.n, 360):
            a = azimuths[start:start + 360]
            heading = np.cos(a)[:, None] * self.north + np.sin(a)[:, None] * self.east
            u = (np.cos(t)[None, :, None] * self.up
                 + np.sin(t)[None, :, None] * heading[:, None, :])
            x, y = unit_to_xy(u)
            self._add_samples(x, y, grid.height_xy(x.ravel(), y.ravel()), gi)

    # ---- step 2: blocks ---------------------------------------------------------

    def _search_grid(self, gi: int) -> None:
        grid = self.source.grids[gi]
        spec = grid.spec
        pyramid = grid.pyramid(self.source.unknown_height_m)
        cell_rows, cell_cols = spec.n_rows - 1, spec.n_cols - 1
        I = np.zeros(1, dtype=np.int64)
        J = np.zeros(1, dtype=np.int64)
        for k in range(len(pyramid) - 1, -1, -1):
            size = 1 << k
            r0, c0 = I * size, J * size
            h_max = pyramid[k][I, J].astype(float)
            ok = (r0 < cell_rows) & (c0 < cell_cols) & np.isfinite(h_max)
            I, J, r0, c0, h_max = I[ok], J[ok], r0[ok], c0[ok], h_max[ok]
            r1, c1 = np.minimum(r0 + size, cell_rows), np.minimum(c0 + size, cell_cols)
            x0, x1 = spec.x_of_col(c0), spec.x_of_col(c1)
            y0, y1 = spec.y_of_row(r0), spec.y_of_row(r1)
            ok = self._rect_relevant(x0, x1, y1, y0, gi)
            I, J, x0, x1, y0, y1, h_max = I[ok], J[ok], x0[ok], x1[ok], y0[ok], y1[ok], h_max[ok]
            if len(I) == 0:
                return
            cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
            ceiling, first, count, _ = self._ceilings(cx, cy, np.hypot(x1 - x0, y0 - y1) / 2.0, h_max)
            alive = ceiling > _CircularRangeMin(self.lower).query(first, count)
            I, J, cx, cy = I[alive], J[alive], cx[alive], cy[alive]
            self.stats["blocks"] += len(I)
            if len(I) == 0:
                return
            self._add_samples(cx, cy, grid.height_xy(cx, cy), gi)
            if k == 0:
                self._refine_cells(gi, I, J)
                return
            below = pyramid[k - 1].shape
            I = np.concatenate([2 * I, 2 * I, 2 * I + 1, 2 * I + 1])
            J = np.concatenate([2 * J, 2 * J + 1, 2 * J, 2 * J + 1])
            inside = (I < below[0]) & (J < below[1])
            I, J = I[inside], J[inside]

    # ---- step 3: cells and pieces of cells --------------------------------------

    def _refine_cells(self, gi: int, rows: np.ndarray, cols: np.ndarray) -> None:
        grid = self.source.grids[gi]
        spec = grid.spec
        v00 = grid.values(rows, cols).astype(float)
        v01 = grid.values(rows, cols + 1).astype(float)
        v10 = grid.values(rows + 1, cols).astype(float)
        v11 = grid.values(rows + 1, cols + 1).astype(float)
        if not np.all(np.isfinite(v00 + v01 + v10 + v11)):
            raise CoverageError(f"{grid.name}: missing elevation data inside the area searched")
        self.stats["cells"] += len(rows)
        fr = np.zeros(len(rows))
        fc = np.zeros(len(rows))
        size = 1.0
        depth = 0
        while len(rows):
            corner_h = []
            for a, b in ((0.0, 0.0), (0.0, 1.0), (1.0, 0.0), (1.0, 1.0), (0.5, 0.5)):
                rr, cc = fr + a * size, fc + b * size
                h = (v00 * (1 - rr) * (1 - cc) + v01 * (1 - rr) * cc
                     + v10 * rr * (1 - cc) + v11 * rr * cc)
                corner_h.append(h)
                # Corners of a piece are corners or centres of earlier pieces,
                # except at the first level: sample them once, then centres only.
                if depth == 0 or (a, b) == (0.5, 0.5):
                    self._add_samples(spec.x_of_col(cols + cc), spec.y_of_row(rows + rr), h, gi)
            h_max = np.maximum(np.maximum(corner_h[0], corner_h[1]),
                               np.maximum(corner_h[2], corner_h[3]))
            cx = spec.x_of_col(cols + fc + size / 2.0)
            cy = spec.y_of_row(rows + fr + size / 2.0)
            half = size * spec.pixel_m * np.sqrt(0.5)
            ceiling, first, count, theta_c = self._ceilings(cx, cy, np.full(len(rows), half), h_max)
            seen = _CircularRangeMin(self.lower).query(first, count)
            alive = ceiling > seen
            if depth == 0 and alive.any():
                self.reach_theta = max(self.reach_theta, float(theta_c[alive].max()))
            done = alive & ((ceiling <= seen + self.tol) | (depth >= self.max_depth))
            if depth >= self.max_depth:
                self.stats["pieces_at_max_depth"] += int((ceiling > seen + self.tol).sum())
            self.final_el.append(ceiling[done])
            self.final_start.append(first[done])
            self.final_count.append(count[done])
            self.stats["pieces"] += len(rows)
            split = alive & ~done
            if not split.any():
                return
            size /= 2.0
            depth += 1
            rows, cols, fr, fc = rows[split], cols[split], fr[split], fc[split]
            v00, v01, v10, v11 = v00[split], v01[split], v10[split], v11[split]
            rows, cols = np.tile(rows, 4), np.tile(cols, 4)
            fr = np.concatenate([fr, fr, fr + size, fr + size])
            fc = np.concatenate([fc, fc + size, fc, fc + size])
            v00, v01, v10, v11 = (np.tile(v, 4) for v in (v00, v01, v10, v11))

    # ---- step 4: the edge of the data --------------------------------------------

    def _check_beyond_the_maps(self) -> float:
        """Prove that unmapped terrain cannot raise the skyline anywhere.

        Each trusted disc on the sheet is a circle on the sphere (the
        projection maps circles to circles), so everything outside the data
        is outside each of those circles. The nearest such terrain is at
        least ``circle radius - distance to circle centre`` away.

        Returns:
            That distance, radians.

        Raises:
            CoverageError: if terrain beyond the maps, as high as anything on
                the Moon, could rise above the skyline in some direction.
        """
        best = -np.inf
        for cx, cy, radius in self.discs:
            g = float(np.hypot(cx, cy))
            dx, dy = (cx / g, cy / g) if g > 0 else (1.0, 0.0)
            c_near = 2.0 * np.arctan((g - radius) / (2.0 * R_MOON_M))
            c_far = 2.0 * np.arctan((g + radius) / (2.0 * R_MOON_M))
            centre = 2.0 * R_MOON_M * np.tan((c_near + c_far) / 4.0)
            cap_centre = xy_to_unit(centre * dx, centre * dy)
            best = max(best, (c_far - c_near) / 2.0 - float(self._angle_from_site(cap_centre)))
        ceiling = float(self._elevation_ceiling(best, np.pi, self.source.unknown_height_m))
        risky = ceiling > self.lower
        if best <= 0 or risky.any():
            raise CoverageError(
                f"the search would have to leave the elevation data: terrain beyond the maps "
                f"(from {best * R_MOON_M / 1000:.1f} km away, up to "
                f"{self.source.unknown_height_m:.0f} m high) could appear at up to {ceiling:.3f} deg, "
                f"above the skyline in {int(risky.sum())} of {self.n} directions")
        return best

    # ---- all together ---------------------------------------------------------------

    def run(self) -> SkylineResult:
        started = time.perf_counter()
        for gi in range(len(self.source.grids)):
            self._seed(gi)
        for gi in range(len(self.source.grids)):
            self._search_grid(gi)
        beyond = self._check_beyond_the_maps()

        upper = self.lower.copy()
        if self.final_el:
            el = np.concatenate(self.final_el)
            first = np.concatenate(self.final_start) % self.n
            count = np.concatenate(self.final_count)
            full = count >= self.n
            if full.any():
                upper = np.maximum(upper, el[full].max())
            reps = count[~full]
            if reps.sum():
                offsets = np.arange(reps.sum()) - np.repeat(np.cumsum(reps) - reps, reps)
                wedges = (np.repeat(first[~full], reps) + offsets) % self.n
                np.maximum.at(upper, wedges, np.repeat(el[~full], reps))
        upper = np.maximum(upper, self.lower)

        self.stats["seconds"] = time.perf_counter() - started
        self.stats["unmapped_terrain_from_km"] = beyond * R_MOON_M / 1000.0
        return SkylineResult(
            lat=self.lat, lon=self.lon, elev_m=self.elev_m, mast_m=self.mast_m,
            az_step_deg=self.step, lower_deg=self.lower, upper_deg=upper,
            max_reach_km=self.reach_theta * R_MOON_M / 1000.0, dem=self.source.names,
            resolution_m=self.source.resolution_at(self.lat, self.lon), stats=self.stats)


def compute_skyline(source: ElevationSource, lat_deg: float, lon_deg: float,
                    mast_m: float = 2.0, az_step_deg: float = 0.1,
                    tolerance_deg: float = TOLERANCE_DEG,
                    max_depth: int = MAX_DEPTH) -> SkylineResult:
    """The skyline at a point, with a guaranteed interval in every wedge.

    Args:
        source: the terrain.
        lat_deg, lon_deg: the point, degrees (longitude east positive). The
            pole itself is refused: north is undefined there, so the caller
            must nudge the point off it.
        mast_m: eye height above the ground, metres.
        az_step_deg: wedge width, degrees; must divide 360.
        tolerance_deg: target half-width... see ``TOLERANCE_DEG``.
        max_depth: see ``MAX_DEPTH``.

    Returns:
        A :class:`SkylineResult`.

    Raises:
        ValueError: for an invalid argument.
        CoverageError: if the point has no data, or if terrain beyond the
            maps could matter.
    """
    if not (np.isfinite(lat_deg) and -90.0 < lat_deg <= 90.0):
        raise ValueError(f"latitude {lat_deg} must be above -90 (nudge the point off the pole)")
    if not (np.isfinite(lon_deg) and -180.0 <= lon_deg <= 180.0):
        raise ValueError(f"longitude {lon_deg} must be between -180 and 180")
    if not (np.isfinite(mast_m) and mast_m >= 0.0):
        raise ValueError(f"mast_m {mast_m} must be zero or positive")
    wedge_count(az_step_deg)
    search = _Search(source, float(lat_deg), float(lon_deg), float(mast_m), az_step_deg,
                     tolerance_deg, max_depth)
    return search.run()
