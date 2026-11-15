"""The LOLA south polar elevation maps, read from their GeoTIFF files.

Role
    The real-data backend of :class:`lunar_engine.elevation.ElevationSource`
    (spec section 3). It answers every question the skyline engine and the
    error model ask, from maps far too large to hold in memory: the 10 m map
    alone is 43,280 x 43,280 pixels (7.5 GB of heights plus 7.5 GB of
    errors) on a machine with 15 GB.

How it works, in plain words
    * **Decompress once.** The first time a map is used, its GeoTIFF is
      decompressed strip by strip into a plain file of 32-bit numbers in
      ``python/dem/cache/``, and so is its error map. Afterwards the files
      are opened "memory-mapped": the operating system reads from disk only
      the pixels actually asked for. A small ``meta.json`` records which
      source file (size and date) each cache came from, so a changed source
      is never read through an old cache.
    * **Highest-terrain tables from 2 x 2 cells upward** are built strip by
      strip and kept on disk. The finest level (single cells) is not stored:
      it is the highest of a cell's four pixels, read on demand.
    * **Slopes are computed on demand** from the 5 x 5 pixels around a
      point, exactly as for in-memory maps.
    * **Slope table for the error model.** A sideways shift of the map
      changes heights by up to the shift times the steepest slope within
      reach. A small table holds the steepest slope bound of every 8 x 8
      pixel block; the reach is covered by whole blocks, which can only make
      the bound larger (safer), never smaller.

    Everything is read exactly as the label says: south polar stereographic
    on the 1737.4 km sphere, true scale at the pole, square pixels, row 0 at
    the largest y, values belonging to pixel areas (centres), heights in
    metres above the sphere, missing values NaN. The reader checks each of
    these against the file and refuses a file that differs.

Units: metres.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from .elevation import ElevationSource, GridSpec, HeightGrid

#: Increase to rebuild every cache (after a change in how caches are made).
CACHE_VERSION = 1
#: Pixels per side of a block of the slope table.
BLOCK = 8
#: Rows handled at a time when building caches.
ROWS_PER_STRIP = 1024
DEFAULT_CACHE = Path(__file__).resolve().parents[1] / "dem" / "cache"
#: Horizontal accuracy of the LOLA polar products, metres. Barker et al. 2023
#: (Planet. Sci. J. 4, 183), section 3: "we consider 1.00/1.00/0.15 m as a
#: conservative estimate of the final track geolocation errors" (along-track,
#: cross-track, radial).
HORIZONTAL_ERROR_M = 1.0


class LabelError(Exception):
    """A map file is not laid out the way the reader requires."""


def read_label(path: Path) -> dict:
    """What the GeoTIFF says about itself, checked against the reader's assumptions.

    Returns:
        ``pixel_m``, ``x_left``, ``y_top``, ``n_rows``, ``n_cols``, ``nodata``
        and the projection text.

    Raises:
        LabelError: for a different projection, sphere, pixel layout or
            registration.
    """
    import rasterio

    with rasterio.open(path) as raster:
        t = raster.transform
        wkt = raster.crs.to_wkt() if raster.crs else ""
        label = {"pixel_m": float(t.a), "x_left": float(t.c), "y_top": float(t.f),
                 "n_rows": raster.height, "n_cols": raster.width, "nodata": raster.nodata,
                 "dtype": raster.dtypes[0], "bands": raster.count,
                 "area_or_point": raster.tags().get("AREA_OR_POINT"), "crs": wkt}
    problems = []
    if label["bands"] != 1:
        problems.append(f"{label['bands']} bands, expected 1")
    if t.b != 0 or t.d != 0 or not t.a == -t.e > 0:
        problems.append("pixels are not square and axis-aligned with row 0 at the top")
    if "Polar_Stereographic" not in wkt or "1737400" not in wkt:
        problems.append("not polar stereographic on the 1737.4 km sphere")
    if 'PARAMETER["latitude_of_origin",-90]' not in wkt or 'PARAMETER["central_meridian",0]' not in wkt:
        problems.append("not centred on the south pole with central meridian 0")
    if label["area_or_point"] != "Area":
        problems.append(f"registration {label['area_or_point']!r}, expected 'Area'")
    if label["dtype"] != "float32":
        problems.append(f"values are {label['dtype']}, expected float32")
    if label["nodata"] is not None and not (isinstance(label["nodata"], float) and math.isnan(label["nodata"])):
        problems.append(f"no-data value {label['nodata']}, expected NaN")
    if problems:
        raise LabelError(f"{Path(path).name}: " + "; ".join(problems))
    return label


def _source_stamp(path: Path) -> dict:
    stat = Path(path).stat()
    return {"file": Path(path).name, "bytes": stat.st_size, "mtime": int(stat.st_mtime)}


def _raw_cache(source: Path, dest: Path, label: dict, log) -> np.ndarray:
    """Decompress a GeoTIFF into a memory-mapped array file (once), and open it."""
    import rasterio
    from rasterio.windows import Window

    meta_path = dest.with_suffix(".json")
    stamp = {**_source_stamp(source), "version": CACHE_VERSION}
    if dest.exists() and meta_path.exists() and json.loads(meta_path.read_text()) == stamp:
        return np.load(dest, mmap_mode="r")
    dest.parent.mkdir(parents=True, exist_ok=True)
    rows, cols = label["n_rows"], label["n_cols"]
    out = np.lib.format.open_memmap(dest, mode="w+", dtype=np.float32, shape=(rows, cols))
    with rasterio.open(source) as raster:
        for r0 in range(0, rows, ROWS_PER_STRIP):
            r1 = min(r0 + ROWS_PER_STRIP, rows)
            out[r0:r1] = raster.read(1, window=Window(0, r0, cols, r1 - r0))
            log(f"  {source.name}: decompressed rows {r1} of {rows}")
    out.flush()
    del out
    meta_path.write_text(json.dumps(stamp))
    return np.load(dest, mmap_mode="r")


def _float32_up(values) -> np.ndarray:
    """Store upper limits as 32-bit numbers, rounding up, never down."""
    v = np.asarray(values, dtype=np.float64)
    v32 = v.astype(np.float32)
    return np.where(v32.astype(np.float64) < v, np.nextafter(v32, np.float32(np.inf)), v32)


class _CellMaxLevel:
    """Level 0 of a highest-terrain table, read on demand: the highest of a
    cell's four pixels (optionally raised). A cell with a missing pixel
    counts as ``missing_as``, as in :func:`lunar_engine.elevation.max_pyramid`."""

    def __init__(self, grid: "LolaGrid", missing_as: float, k_sigma: float | None = None):
        self.grid, self.missing_as, self.k_sigma = grid, missing_as, k_sigma
        self.shape = (grid.spec.n_rows - 1, grid.spec.n_cols - 1)

    def __getitem__(self, index):
        rows, cols = (np.asarray(i, dtype=np.int64) for i in index)
        best = np.full(rows.shape, -np.inf)
        for dr, dc in ((0, 0), (0, 1), (1, 0), (1, 1)):
            r, c = rows + dr, cols + dc
            v = np.asarray(self.grid.values(r, c), dtype=float)
            if self.k_sigma is not None:
                v = v + self.grid.own_allowance(r, c, self.k_sigma)
            best = np.maximum(best, v)                          # NaN spreads: the cell is missing
        return np.where(np.isnan(best), self.missing_as, best)


class LolaGrid(HeightGrid):
    """One LOLA map (heights and, optionally, its error map) backed by files on disk.

    Args:
        path: the height GeoTIFF.
        error_path: the matching ``_ERR`` GeoTIFF (same grid), or ``None``.
        horizontal_error_m: the product's horizontal accuracy, metres.
        cache_root: where decompressed copies and tables are kept.
        log: called with progress lines while caches are built.
    """

    def __init__(self, path, error_path=None, horizontal_error_m: float = 0.0,
                 cache_root: Path = DEFAULT_CACHE, log=print):
        path = Path(path)
        label = read_label(path)
        spec = GridSpec(label["pixel_m"], label["x_left"], label["y_top"], label["n_rows"], label["n_cols"])
        self.name = path.stem
        self.spec = spec
        self.label = label
        self.horizontal_error_m = float(horizontal_error_m)
        self.cache = Path(cache_root) / self.name
        self.log = log
        self._heights = _raw_cache(path, self.cache / "heights.npy", label, log)
        self._errors = None
        if error_path is not None:
            error_label = read_label(Path(error_path))
            if (error_label["pixel_m"], error_label["x_left"], error_label["y_top"],
                    error_label["n_rows"], error_label["n_cols"]) != (
                    label["pixel_m"], label["x_left"], label["y_top"], label["n_rows"], label["n_cols"]):
                raise LabelError(f"{Path(error_path).name} is not on the same grid as {path.name}")
            self._errors = _raw_cache(Path(error_path), self.cache / "errors.npy", error_label, log)
        self._pyramids: dict = {}
        self._disc = None
        self._block_slopes = None
        self._stamp = {**_source_stamp(path), "version": CACHE_VERSION,
                       "errors": _source_stamp(Path(error_path)) if error_path else None}

    # ---- small cached results ------------------------------------------------------

    def _meta(self) -> dict:
        path = self.cache / "meta.json"
        if path.exists():
            meta = json.loads(path.read_text())
            if meta.get("stamp") == self._stamp:
                return meta
        return {"stamp": self._stamp}

    def _save_meta(self, meta: dict) -> None:
        (self.cache / "meta.json").write_text(json.dumps(meta, indent=1))

    def _strips(self, n_rows: int):
        for r0 in range(0, n_rows, ROWS_PER_STRIP):
            yield r0, min(r0 + ROWS_PER_STRIP, n_rows)

    # ---- trusted disc -----------------------------------------------------------------

    def disc(self) -> tuple[float, float, float]:
        """As :meth:`HeightGrid.disc`, computed strip by strip and cached."""
        if self._disc is None:
            meta = self._meta()
            if "disc" not in meta:
                spec = self.spec
                cx = spec.x_left + spec.n_cols * spec.pixel_m / 2
                cy = spec.y_top - spec.n_rows * spec.pixel_m / 2
                radius = min(spec.n_cols - 1, spec.n_rows - 1) * spec.pixel_m / 2
                nearest = np.inf
                for r0, r1 in self._strips(spec.n_rows):
                    missing = np.argwhere(np.isnan(self._heights[r0:r1]))
                    if len(missing):
                        d = np.hypot(spec.x_of_col(missing[:, 1]) - cx, spec.y_of_row(missing[:, 0] + r0) - cy)
                        nearest = min(nearest, float(d.min()))
                if np.isfinite(nearest):
                    radius = min(radius, nearest - np.sqrt(2.0) * spec.pixel_m * (1 + 1e-9))
                meta["disc"] = [float(cx), float(cy), float(max(radius, 0.0))]
                meta["nearest_missing_m"] = None if not np.isfinite(nearest) else nearest
                self._save_meta(meta)
            self._disc = tuple(meta["disc"])
        return self._disc

    # ---- highest-terrain tables ---------------------------------------------------------

    def _level_file(self, name: str, level: int) -> Path:
        return self.cache / f"{name}_level{level}.npy"

    def _build_levels(self, name: str, first_level_strip, missing_as: float) -> list:
        """Build levels 1 and up of a table on disk, from a function giving
        level 1 for a range of its rows; returns the opened levels."""
        meta = self._meta()
        key = f"levels:{name}"
        n_cell_rows, n_cell_cols = self.spec.n_rows - 1, self.spec.n_cols - 1
        shape = ((n_cell_rows + 1) // 2, (n_cell_cols + 1) // 2)
        if meta.get(key) is None:
            out = np.lib.format.open_memmap(self._level_file(name, 1), mode="w+", dtype=np.float32, shape=shape)
            for i0 in range(0, shape[0], ROWS_PER_STRIP // 2):
                i1 = min(i0 + ROWS_PER_STRIP // 2, shape[0])
                out[i0:i1] = first_level_strip(i0, i1, shape[1])
            out.flush()
            del out
            level, k = np.load(self._level_file(name, 1), mmap_mode="r"), 1
            while level.shape != (1, 1):
                rows, cols = level.shape
                new_shape = ((rows + 1) // 2, (cols + 1) // 2)
                out = np.lib.format.open_memmap(self._level_file(name, k + 1), mode="w+",
                                                dtype=np.float32, shape=new_shape)
                for i0 in range(0, new_shape[0], ROWS_PER_STRIP):
                    i1 = min(i0 + ROWS_PER_STRIP, new_shape[0])
                    block = np.asarray(level[2 * i0:2 * i1])
                    if block.shape[0] % 2:
                        block = np.vstack([block, np.full((1, cols), -np.inf, np.float32)])
                    if cols % 2:
                        block = np.hstack([block, np.full((block.shape[0], 1), -np.inf, np.float32)])
                    out[i0:i1] = block.reshape(block.shape[0] // 2, 2, block.shape[1] // 2, 2).max(axis=(1, 3))
                out.flush()
                del out
                k += 1
                level = np.load(self._level_file(name, k), mmap_mode="r")
            meta[key] = k
            self._save_meta(meta)
            self.log(f"  {self.name}: built table '{name}' ({k} levels)")
        top = meta[key]
        return [np.load(self._level_file(name, j), mmap_mode="r") for j in range(1, top + 1)]

    def _first_level(self, heights_of_rows, i0: int, i1: int, n_out_cols: int, missing_as: float):
        """Level 1 (2 x 2 cells = 3 x 3 pixels) for rows ``i0..i1-1``, from a
        function giving pixel heights for a range of pixel rows."""
        p0, p1 = 2 * i0, min(2 * i1 + 1, self.spec.n_rows)
        h = np.asarray(heights_of_rows(p0, p1), dtype=np.float64)
        # Cells (with a missing corner the cell is missing), then 2 x 2 blocks of cells.
        cells = np.maximum(np.maximum(h[:-1, :-1], h[:-1, 1:]), np.maximum(h[1:, :-1], h[1:, 1:]))
        cells = np.where(np.isnan(cells), missing_as, cells)
        padded = np.full((2 * (i1 - i0), 2 * n_out_cols), -np.inf)
        padded[:cells.shape[0], :cells.shape[1]] = cells
        blocks = padded.reshape(i1 - i0, 2, n_out_cols, 2).max(axis=(1, 3))
        return _float32_up(blocks)

    def pyramid(self, missing_as: float) -> list:
        """Highest-terrain tables (:func:`lunar_engine.elevation.max_pyramid`),
        level 0 read on demand, levels 1 and up from disk."""
        key = ("nominal", float(missing_as))
        if key not in self._pyramids:
            levels = self._build_levels(f"max_{missing_as:g}", lambda i0, i1, nc: self._first_level(
                lambda a, b: self._heights[a:b], i0, i1, nc, missing_as), missing_as)
            self._pyramids[key] = [_CellMaxLevel(self, missing_as)] + levels
        return self._pyramids[key]

    def _top_height(self) -> float:
        meta = self._meta()
        if "top_height" not in meta:
            top = -np.inf
            for r0, r1 in self._strips(self.spec.n_rows):
                top = max(top, float(np.nanmax(self._heights[r0:r1])))
            meta["top_height"] = top
            self._save_meta(meta)
        return meta["top_height"]

    # ---- slopes, computed on demand ---------------------------------------------------------

    def slope_bound(self, rows, cols) -> np.ndarray:
        """As :meth:`HeightGrid.slope_bound`, from the 5 x 5 pixels around each pixel."""
        rows, cols = np.asarray(rows, dtype=np.int64), np.asarray(cols, dtype=np.int64)
        n_rows, n_cols = self.spec.n_rows, self.spec.n_cols
        window = {}
        for dr in range(-2, 3):
            for dc in range(-2, 3):
                r, c = rows + dr, cols + dc
                inside = (r >= 0) & (r < n_rows) & (c >= 0) & (c < n_cols)
                v = np.asarray(self._heights[np.clip(r, 0, n_rows - 1), np.clip(c, 0, n_cols - 1)], dtype=float)
                window[dr, dc] = np.where(inside, v, np.nan)
        steepest = np.full(rows.shape, np.nan)
        for qr in (-1, 0, 1):
            for qc in (-1, 0, 1):
                for nr in (-1, 0, 1):
                    for nc in (-1, 0, 1):
                        if nr == nc == 0:
                            continue
                        rise = np.abs(window[qr + nr, qc + nc] - window[qr, qc]) / (
                            self.spec.pixel_m * math.hypot(nr, nc))
                        steepest = np.fmax(steepest, rise)
        return np.sqrt(2.0) * steepest

    def local_slopes(self):
        raise NotImplementedError("a LOLA map is too large; use slope_bound on pixels")

    def gradient_bound(self):
        raise NotImplementedError("not used for LOLA maps")

    # ---- the error model ----------------------------------------------------------------------

    def _block_slope_table(self) -> np.ndarray:
        """Steepest :meth:`slope_bound` in every BLOCK x BLOCK pixel block (cached on disk)."""
        if self._block_slopes is None:
            path = self.cache / f"block_slopes_{BLOCK}.npy"
            meta = self._meta()
            if not (path.exists() and meta.get("block_slopes")):
                n_rows, n_cols = self.spec.n_rows, self.spec.n_cols
                n_br, n_bc = -(-n_rows // BLOCK), -(-n_cols // BLOCK)
                table = np.zeros((n_br, n_bc), dtype=np.float32)
                strip = (ROWS_PER_STRIP // BLOCK) * BLOCK
                for r0 in range(0, n_rows, strip):
                    r1 = min(r0 + strip, n_rows)
                    a0, a1 = max(r0 - 2, 0), min(r1 + 2, n_rows)
                    h = np.asarray(self._heights[a0:a1], dtype=float)
                    slopes = _local_slopes_array(h, self.spec.pixel_m)
                    bound = np.sqrt(2.0) * _max3x3(slopes)
                    bound = np.nan_to_num(bound[r0 - a0:r0 - a0 + (r1 - r0)])
                    rows = r1 - r0
                    pad_r, pad_c = -(-rows // BLOCK) * BLOCK - rows, n_bc * BLOCK - n_cols
                    bound = np.pad(bound, ((0, pad_r), (0, pad_c)))
                    table[r0 // BLOCK:r0 // BLOCK + bound.shape[0] // BLOCK] = _float32_up(bound.reshape(
                        bound.shape[0] // BLOCK, BLOCK, n_bc, BLOCK).max(axis=(1, 3)))
                np.save(path, _float32_up(table.astype(np.float64) * (1.0 + 1e-6)))
                meta["block_slopes"] = True
                self._save_meta(meta)
            self._block_slopes = np.load(path)
        return self._block_slopes

    def _shift_at(self, rows, cols) -> np.ndarray:
        """What a sideways shift by ``horizontal_error_m`` can change at pixels, metres.

        The shift times the steepest slope bound of every block within
        ``shift + 2 sqrt(2) pixel`` of the pixel (whole blocks: a little more
        than needed, never less)."""
        shift = self.horizontal_error_m
        rows, cols = np.asarray(rows, dtype=np.int64), np.asarray(cols, dtype=np.int64)
        if shift <= 0.0:
            return np.zeros(rows.shape)
        table = self._block_slope_table()
        reach = int(math.ceil((shift + 2.0 * math.sqrt(2.0) * self.spec.pixel_m) / self.spec.pixel_m))
        nb = reach // BLOCK + 1
        br, bc = rows // BLOCK, cols // BLOCK
        steepest = np.zeros(rows.shape)
        for dr in range(-nb, nb + 1):
            for dc in range(-nb, nb + 1):
                r, c = np.clip(br + dr, 0, table.shape[0] - 1), np.clip(bc + dc, 0, table.shape[1] - 1)
                steepest = np.maximum(steepest, table[r, c])
        return shift * steepest

    def _shift_rows(self, p0: int, p1: int) -> np.ndarray:
        """:meth:`_shift_at` for whole pixel rows ``p0..p1-1``."""
        if self.horizontal_error_m <= 0.0:
            return np.zeros((p1 - p0, self.spec.n_cols))
        rows, cols = np.indices((p1 - p0, self.spec.n_cols))
        return self._shift_at(rows + p0, cols)

    def own_allowance(self, rows, cols, k_sigma: float) -> np.ndarray:
        sigma = self.error_values(rows, cols)
        sigma = np.zeros(np.shape(rows)) if sigma is None else np.nan_to_num(np.asarray(sigma, dtype=float))
        return k_sigma * sigma + self._shift_at(rows, cols)

    def max_own_allowance(self, k_sigma: float) -> float:
        meta = self._meta()
        if "max_sigma" not in meta:
            top = 0.0
            if self._errors is not None:
                for r0, r1 in self._strips(self.spec.n_rows):
                    top = max(top, float(np.nanmax(self._errors[r0:r1])))
            meta["max_sigma"] = top
            self._save_meta(meta)
        shift = self.horizontal_error_m * float(self._block_slope_table().max()) if self.horizontal_error_m > 0 else 0.0
        return k_sigma * meta["max_sigma"] + shift

    def raised_pyramid(self, k_sigma: float, missing_as: float) -> list:
        key = ("raised", float(k_sigma), float(missing_as))
        if key not in self._pyramids:
            def raised_rows(p0, p1):
                h = np.asarray(self._heights[p0:p1], dtype=float)
                sigma = (np.zeros(h.shape) if self._errors is None
                         else np.nan_to_num(np.asarray(self._errors[p0:p1], dtype=float)))
                return h + k_sigma * sigma + self._shift_rows(p0, p1)
            name = f"raised_k{k_sigma:g}_h{self.horizontal_error_m:g}_{missing_as:g}"
            levels = self._build_levels(name, lambda i0, i1, nc: self._first_level(
                raised_rows, i0, i1, nc, missing_as), missing_as)
            self._pyramids[key] = [_CellMaxLevel(self, missing_as, k_sigma)] + levels
        return self._pyramids[key]


def _local_slopes_array(h: np.ndarray, pixel_m: float) -> np.ndarray:
    """Steepest rise to any of the 8 neighbours, for every pixel of an array."""
    padded = np.pad(h, 1, constant_values=np.nan)
    steepest = np.full(h.shape, np.nan)
    rows, cols = h.shape
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr == dc == 0:
                continue
            neighbour = padded[1 + dr:1 + dr + rows, 1 + dc:1 + dc + cols]
            steepest = np.fmax(steepest, np.abs(neighbour - h) / (pixel_m * math.hypot(dr, dc)))
    return steepest


def _max3x3(a: np.ndarray) -> np.ndarray:
    padded = np.pad(a, 1, constant_values=np.nan)
    out = np.full(a.shape, np.nan)
    rows, cols = a.shape
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            out = np.fmax(out, padded[1 + dr:1 + dr + rows, 1 + dc:1 + dc + cols])
    return out


#: The maps used, finest first: (height file, error file).
PRODUCTS = (
    ("LDEM_83S_10MPP_ADJ.TIF", "LDEM_83S_10MPP_ADJ_ERR.TIF"),
    ("LDEM_80S_20MPP_ADJ.TIF", "LDEM_80S_20MPP_ADJ_ERR.TIF"),
    ("LDEM_75S_30MPP_ADJ.TIF", "LDEM_75S_30MPP_ADJ_ERR.TIF"),
    ("LDEM_60S_60MPP_ADJ.TIF", "LDEM_60S_60MPP_ADJ_ERR.TIF"),
)
COARSE_PRODUCTS = (
    ("LDEM_80S_80MPP_ADJ.TIF", "LDEM_80S_80MPP_ADJ_ERR.TIF"),
    ("LDEM_60S_240MPP_ADJ.TIF", "LDEM_60S_240MPP_ADJ_ERR.TIF"),
)


def open_lola(dem_dir: Path, products=PRODUCTS, horizontal_error_m: float = HORIZONTAL_ERROR_M,
              cache_root: Path = DEFAULT_CACHE, log=print) -> ElevationSource:
    """The real terrain: the given LOLA maps behind one ElevationSource.

    Args:
        dem_dir: folder with the GeoTIFFs (``python/dem``).
        products: ``(height file, error file)`` pairs; the error file may be ``None``.
        horizontal_error_m: the products' horizontal accuracy, metres.
    """
    grids = [LolaGrid(Path(dem_dir) / heights, Path(dem_dir) / errors if errors else None,
                      horizontal_error_m, cache_root, log) for heights, errors in products]
    return ElevationSource(grids)
