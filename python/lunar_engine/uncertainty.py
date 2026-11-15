"""The skyline's error bound, ``skyline_err_deg`` (spec section 7).

Role
    Turns the skyline engine's per-wedge interval into the contract's
    ``skyline_deg`` and ``skyline_err_deg``, adding the error of the
    elevation maps themselves. With them the browser classifies a direction
    in a wedge as **lit** (above ``skyline + err``: certainly clear),
    **blocked** (below ``skyline - err``: certainly hidden) or **uncertain**.

What the interval covers
    For every wedge, ``skyline_deg +/- skyline_err_deg`` contains the skyline
    at **every single azimuth** of the wedge, for **any terrain within the
    error model** below. That is what makes both "lit" and "blocked"
    provable: the wedge's highest terrain is below the top of the interval,
    and the lowest the skyline gets inside the wedge is above its bottom.

How it works, in plain words
    The skyline is computed three times:

    * on the map as it is (reported for comparison);
    * on the map **raised** everywhere by the error allowed at each point;
      its proven ceiling is the top of the interval;
    * on the map **lowered** the same way; its proven floor is the bottom.

    Higher terrain can only raise the skyline and lower terrain only lower
    it, so any terrain in between has its skyline in between. The middle of
    the interval is reported as ``skyline_deg`` and half its width as
    ``skyline_err_deg``, plus the small angle between the frame of the
    Sun/Earth timetable and the frame of the maps.

The error model (proposed; see ``docs/PROGRESS.md``)
    The height of terrain relative to the eye may be wrong at a point by up to

        allowed(x) = min( E(x) + E(site),  max(0, D(x) - r0) * tan(SLOPE_ERROR_DEG) )

    where ``E = K_SIGMA * sigma + shift``:

    * ``sigma`` is the map's published height error at the pixel (the error
      maps that come with the LOLA products);
    * ``K_SIGMA`` turns it into a bound (3: three standard deviations);
    * ``shift`` is how much a sideways shift of the whole map by up to its
      horizontal accuracy can change the height at the point: the shift
      times the steepest slope within reach of it
      (:meth:`lunar_engine.elevation.HeightGrid.shift_allowance`);
    * ``D`` is the distance from the site. Nearby terrain comes from the
      same measurements as the site, so its error relative to the eye cannot
      grow faster than an error in slope allows (``SLOPE_ERROR_DEG``).
      Without this, independent 3-sigma errors at the eye and at ground 10 m
      away would wall in every site.
    * ``r0`` is one pixel diagonal of the map at the site. Pixels that close
      share the site's own cell, whose surface the map defines by blending
      them; the map holds no independent information there, and the spec
      claims accuracy only at the resolution of the data. Without it, the
      blend would carry the full allowance of the cell's corners right up
      to the eye.

Units: degrees and metres.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .elevation import ElevationSource, HeightGrid, cell_max, max_pyramid, to_xy, xy_to_unit
from .geometry import R_MOON_M, enu_frame
from .skyline import ROUNDING_MARGIN_DEG, SkylineResult, compute_skyline

#: Published height errors are standard deviations; this many make the bound.
K_SIGMA = 3.0
#: The most the slope between the site and nearby terrain may be wrong, degrees.
SLOPE_ERROR_DEG = 6.0
#: Largest angle between the timetable's frame (MOON_ME of DE440) and the
#: frame of the LOLA maps (MOON_ME of DE421) for 2026 to 2040, degrees.
#: Measured in test_ephemeris.py: 3.06e-7 rad.
FRAME_ANGLE_DEG = 1.76e-5


@dataclass
class SkylineBounds:
    """A skyline with its full error bound, ready for the Contract 3 record.

    Attributes:
        lat, lon, elev_m, mast_m, az_step_deg: as in :class:`SkylineResult`.
        skyline_deg, skyline_err_deg: per wedge, degrees (Contract 3).
        max_reach_km, dem, resolution_m: as in :class:`SkylineResult`, from
            the raised terrain (which has to be searched farthest).
        nominal: the skyline of the map as it is, with its own interval.
        parts: per wedge, the share of the error from each source, degrees:
            ``numerical`` (half the nominal interval, including how much the
            skyline varies inside the wedge) and ``terrain`` (what the map
            error adds on top).
    """

    lat: float
    lon: float
    elev_m: float
    mast_m: float
    az_step_deg: float
    skyline_deg: np.ndarray
    skyline_err_deg: np.ndarray
    max_reach_km: float
    dem: list[str]
    resolution_m: float
    nominal: SkylineResult
    parts: dict = field(default_factory=dict)


class _ShiftedGrid(HeightGrid):
    """A map whose every pixel is moved up (or down) by the error allowed there.

    It answers the same questions as :class:`HeightGrid`; only the heights
    differ. The allowed error depends on the distance from the site, so one
    such map belongs to one site.
    """

    def __init__(self, base: HeightGrid, sign: float, site_unit: np.ndarray,
                 site_allowance_m: float, near_m: float, k_sigma: float, slope_error_deg: float):
        self.name = base.name
        self.spec = base.spec
        self.base = base
        self.sign = sign
        self.site_unit = site_unit
        self.site_allowance_m = site_allowance_m
        self.near_m = near_m
        self.k_sigma = k_sigma
        self.tan_slope_error = np.tan(np.radians(slope_error_deg))
        self._errors = base._errors
        self.horizontal_error_m = base.horizontal_error_m
        self._pyramids = {}
        self._disc = base.disc()
        self._slopes = None
        self._slope_bounds = None
        self._heights = None
        self._max_allowance = None

    def _own_allowance(self, rows, cols) -> np.ndarray:
        """``E`` at pixels: K * sigma + what a sideways shift can change, metres."""
        sigma = self.base.error_values(rows, cols)
        sigma = np.zeros(np.shape(rows)) if sigma is None else np.nan_to_num(sigma.astype(float))
        shift = self.base.shift_allowance(self.base.horizontal_error_m)[rows, cols]
        return self.k_sigma * sigma + shift

    def values(self, rows, cols) -> np.ndarray:
        """Heights moved by the allowed error, metres."""
        rows, cols = np.asarray(rows), np.asarray(cols)
        u = xy_to_unit(self.spec.x_of_col(cols), self.spec.y_of_row(rows))
        chord = np.linalg.norm(u - self.site_unit, axis=-1)
        distance = 2.0 * R_MOON_M * np.arcsin(np.clip(chord / 2.0, 0.0, 1.0))
        allowance = np.minimum(self._own_allowance(rows, cols) + self.site_allowance_m,
                               np.maximum(distance - self.near_m, 0.0) * self.tan_slope_error)
        return self.base.values(rows, cols).astype(float) + self.sign * allowance

    def error_values(self, rows, cols):
        return self.base.error_values(rows, cols)

    def pyramid(self, missing_as: float) -> list[np.ndarray]:
        """Highest-terrain tables valid for the moved map.

        Lowered: the original tables are still upper limits. Raised: tables
        of ``height + E`` (the same for every site, so cached on the base
        map) plus the site's own allowance, which is never smaller than the
        allowance actually applied.
        """
        if self.sign < 0:
            return self.base.pyramid(missing_as)
        key = ("raised", self.k_sigma, missing_as)
        if key not in self.base._pyramids:
            rows, cols = np.indices((self.spec.n_rows, self.spec.n_cols))
            raised = self.base._heights.astype(float) + self._own_allowance(rows, cols)
            self.base._pyramids[key] = max_pyramid(cell_max(raised), missing_as)
        return [level + self.site_allowance_m for level in self.base._pyramids[key]]

    def disc(self):
        return self._disc

    def max_allowance(self) -> float:
        """The largest error allowed anywhere in this map, metres (cached)."""
        if self._max_allowance is None:
            rows, cols = np.indices((self.spec.n_rows, self.spec.n_cols))
            self._max_allowance = float(np.nanmax(self._own_allowance(rows, cols))
                                        + self.site_allowance_m)
        return self._max_allowance

    def slope_bound(self, rows, cols) -> np.ndarray:
        """How steep the moved surface can be near a pixel.

        The map's own bound plus how fast the allowed error can change. The
        allowance lies between 0 and its largest value everywhere, so between
        neighbouring pixels it changes by at most that largest value, which
        is at most ``largest / pixel`` per metre along each axis. The factor 2
        covers both axes of a cell (``sqrt(2)``) with room. With no allowed
        error the bound is the map's own.
        """
        extra = 2.0 * self.max_allowance() / self.spec.pixel_m
        return self.base.slope_bound(rows, cols) + extra


class _ShiftedSource(ElevationSource):
    """All maps of a source moved up (``sign`` +1) or down (-1) by the allowed error."""

    def __init__(self, source: ElevationSource, sign: float, lat: float, lon: float,
                 k_sigma: float, slope_error_deg: float):
        site_unit = enu_frame(lat, lon)[2]
        site_grid = source.grid_at(lat, lon)
        x, y = (float(v) for v in to_xy(lat, lon))
        spec = site_grid.spec
        col, row = float(spec.col_of_x(x)), float(spec.row_of_y(y))
        rows = np.clip(np.array([np.floor(row), np.floor(row), np.ceil(row), np.ceil(row)]).astype(int),
                       0, spec.n_rows - 1)
        cols = np.clip(np.array([np.floor(col), np.ceil(col), np.floor(col), np.ceil(col)]).astype(int),
                       0, spec.n_cols - 1)
        sigma = site_grid.error_values(rows, cols)
        sigma = 0.0 if sigma is None else float(np.nanmax(sigma))
        shift = float(np.max(site_grid.shift_allowance(site_grid.horizontal_error_m)[rows, cols]))
        site_allowance = k_sigma * sigma + shift
        near_m = np.sqrt(2.0) * spec.pixel_m
        super().__init__([_ShiftedGrid(g, sign, site_unit, site_allowance, near_m, k_sigma,
                                       slope_error_deg) for g in source.grids])
        self.is_real = source.is_real
        # The height assumed for unmapped terrain is already a ceiling for any
        # terrain there, true or shifted, so it is not moved.
        self.unknown_height_m = source.unknown_height_m
        self.site_allowance_m = site_allowance
        self._elev_m = source.height(lat, lon)

    def height(self, lat_deg: float, lon_deg: float) -> float:
        """The site's own height is not moved: errors are relative to the eye."""
        return self._elev_m


def skyline_with_error(source: ElevationSource, lat_deg: float, lon_deg: float,
                       mast_m: float = 2.0, az_step_deg: float = 0.1,
                       k_sigma: float = K_SIGMA,
                       slope_error_deg: float = SLOPE_ERROR_DEG) -> SkylineBounds:
    """The skyline at a point with its full error bound (Contract 3 values).

    Args:
        source: the terrain, with per-pixel height errors where available.
        lat_deg, lon_deg: the point, degrees.
        mast_m: eye height above the ground, metres.
        az_step_deg: wedge width, degrees; must divide 360.
        k_sigma, slope_error_deg: the error model (see the module docstring).

    Returns:
        A :class:`SkylineBounds`.

    Raises:
        ValueError, CoverageError: as :func:`lunar_engine.skyline.compute_skyline`,
            for any of the three runs.
    """
    nominal = compute_skyline(source, lat_deg, lon_deg, mast_m, az_step_deg)
    raised = compute_skyline(_ShiftedSource(source, +1.0, lat_deg, lon_deg, k_sigma, slope_error_deg),
                             lat_deg, lon_deg, mast_m, az_step_deg)
    # The lowered run gives only the bottom of the interval, which terrain
    # beyond the maps cannot lower, so it need not look beyond them.
    lowered = compute_skyline(_ShiftedSource(source, -1.0, lat_deg, lon_deg, k_sigma, slope_error_deg),
                              lat_deg, lon_deg, mast_m, az_step_deg, require_complete=False)
    top = np.maximum(raised.upper_deg, nominal.upper_deg)
    bottom = np.minimum(lowered.floor_deg, nominal.floor_deg)
    skyline = (top + bottom) / 2.0
    err = (top - bottom) / 2.0 + FRAME_ANGLE_DEG + ROUNDING_MARGIN_DEG
    numerical = (nominal.upper_deg - nominal.floor_deg) / 2.0
    return SkylineBounds(
        lat=nominal.lat, lon=nominal.lon, elev_m=nominal.elev_m, mast_m=nominal.mast_m,
        az_step_deg=nominal.az_step_deg, skyline_deg=skyline, skyline_err_deg=err,
        max_reach_km=max(raised.max_reach_km, nominal.max_reach_km), dem=nominal.dem,
        resolution_m=nominal.resolution_m, nominal=nominal,
        parts={"numerical": numerical, "terrain": err - numerical})
