/**
 * Lighting of the terrain picture from the shade grid (display only; the site's own lit or
 * blocked answer always comes from its full skyline).
 *
 * How it works: the Sun's azimuth and elevation are computed once, at the site, and used for
 * every cell (handoff: all shade-grid angles are in the patch centre's frame). A cell receives
 * light in proportion to how much of the Sun's disc stands above that cell's own skyline at the
 * Sun's azimuth, times the cosine between the cell's surface normal and the Sun's direction.
 */
import type { Direction, ShadeGrid } from "../../engine/runtime-types";
import { discRadiusDeg } from "../../engine/astro";
import { azElToEnu } from "./geometry";

/** Skyline elevation of one cell at an azimuth, degrees (step function, as in the contract). */
export function cellSkylineDeg(grid: ShadeGrid, row: number, column: number, azDeg: number): number {
  const { n, n_az, az_step_deg, skyline_scale } = grid.label;
  const a = ((Math.round(azDeg / az_step_deg) % n_az) + n_az) % n_az;
  return grid.skyline[(row * n + column) * n_az + a] * skyline_scale;
}

/**
 * Share of the Sun's disc, by height, that stands above each cell's own skyline: 0 when the
 * disc's top is below it, 1 when its bottom is above. Rows north to south, columns west to east.
 */
export function cellClear(grid: ShadeGrid, sun: Direction): Float32Array {
  const { n } = grid.label;
  const rho = discRadiusDeg("sun", sun.distance_km);
  const clear = new Float32Array(n * n);
  for (let row = 0; row < n; row += 1) {
    for (let column = 0; column < n; column += 1) {
      clear[row * n + column] = Math.min(1, Math.max(0, (sun.el_deg + rho - cellSkylineDeg(grid, row, column, sun.az_deg)) / (2 * rho)));
    }
  }
  return clear;
}

/**
 * Light received by every cell, 0 to 1, rows north to south and columns west to east.
 * `1` would be the Sun overhead on level ground with its whole disc visible.
 */
export function cellLight(grid: ShadeGrid, sun: Direction): Float32Array {
  const { n } = grid.label;
  const clearShare = cellClear(grid, sun);
  const [east, north, up] = azElToEnu(sun.az_deg, sun.el_deg);
  const light = new Float32Array(n * n);
  for (let row = 0; row < n; row += 1) {
    for (let column = 0; column < n; column += 1) {
      const cell = row * n + column;
      const clear = clearShare[cell];
      const cosine = grid.normal[cell * 3] * east + grid.normal[cell * 3 + 1] * north + grid.normal[cell * 3 + 2] * up;
      light[cell] = clear * Math.max(0, cosine);
    }
  }
  return light;
}

/** Read a cell grid at a fractional (row, column) with bilinear interpolation, clamped at the edges. */
export function sampleGrid(values: Float32Array, n: number, row: number, column: number): number {
  const r = Math.min(n - 1, Math.max(0, row));
  const c = Math.min(n - 1, Math.max(0, column));
  const r0 = Math.min(n - 2, Math.floor(r));
  const c0 = Math.min(n - 2, Math.floor(c));
  const fr = r - r0;
  const fc = c - c0;
  return (
    values[r0 * n + c0] * (1 - fr) * (1 - fc) +
    values[r0 * n + c0 + 1] * (1 - fr) * fc +
    values[(r0 + 1) * n + c0] * fr * (1 - fc) +
    values[(r0 + 1) * n + c0 + 1] * fr * fc
  );
}
