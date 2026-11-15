import type { Direction, Visibility } from "./runtime-types";
import type { Skyline } from "./types";
import { discRadiusDeg } from "./astro";
import { degToRad } from "./math";

/**
 * Which skyline is the disc compared with: the nominal skyline (0), the skyline raised by its
 * error bound (+1, pessimistic) or lowered by it (-1, optimistic).
 */
export type SkylineShift = -1 | 0 | 1;

/** One wedge overlapping the disc: its x range across the disc and the height of its terrain above the disc's centre, degrees. */
interface WedgeBand {
  x1: number;
  x2: number;
  threshold: number;
}

/**
 * The skyline wedges that overlap a body's disc, in the disc's tangent plane.
 *
 * x is the angular offset across the disc (azimuth difference times cos(elevation)), y the
 * elevation difference, both degrees, so the disc is a circle of radius `rho`. Entry `k` covers
 * azimuths within half a step of `k * step` (a step function: it is never interpolated). The
 * band list wraps across north.
 */
function wedgeBands(direction: Direction, rho: number, skyline: Skyline, shift: SkylineShift): WedgeBand[] {
  const step = skyline.az_step_deg;
  const n = skyline.skyline_deg.length;
  const cosEl = Math.max(Math.cos(degToRad(direction.el_deg)), 1e-9);
  const halfSpanAz = Math.min(180, rho / cosEl);
  const firstK = Math.round((direction.az_deg - halfSpanAz) / step);
  const lastK = Math.round((direction.az_deg + halfSpanAz) / step);
  const bands: WedgeBand[] = [];
  for (let k = firstK; k <= lastK && k - firstK < n; k += 1) {
    const index = ((k % n) + n) % n;
    const x1 = Math.max(-rho, ((k - 0.5) * step - direction.az_deg) * cosEl);
    const x2 = Math.min(rho, ((k + 0.5) * step - direction.az_deg) * cosEl);
    if (x2 <= x1) continue;
    const height = skyline.skyline_deg[index] + shift * skyline.skyline_err_deg[index];
    bands.push({ x1, x2, threshold: height - direction.el_deg });
  }
  return bands;
}

/** Antiderivative of the disc's upper half-chord sqrt(rho^2 - x^2). */
function halfChordIntegral(x: number, rho: number): number {
  const clipped = Math.max(-rho, Math.min(rho, x));
  return 0.5 * (clipped * Math.sqrt(Math.max(0, rho * rho - clipped * clipped)) + rho * rho * Math.asin(clipped / rho));
}

/**
 * Exact area of the part of a disc (radius `rho`, centred at 0) with x in [x1, x2] and y above `t`.
 *
 * Inside |x| < a = sqrt(rho^2 - t^2) the visible height is chord top minus t. Outside it the
 * disc is either wholly above the line (t < 0) or wholly below it (t > 0).
 */
function bandArea(x1: number, x2: number, t: number, rho: number): number {
  const G = (x: number) => halfChordIntegral(x, rho);
  if (t >= rho) return 0;
  if (t <= -rho) return 2 * (G(x2) - G(x1));
  const a = Math.sqrt(rho * rho - t * t);
  const lo = Math.max(x1, -a);
  const hi = Math.min(x2, a);
  let area = hi > lo ? (G(hi) - G(lo)) - t * (hi - lo) : 0;
  if (t < 0) {
    // The two outer pieces |x| > a, where the whole chord is above the line.
    const leftHi = Math.min(x2, -a);
    if (leftHi > x1) area += 2 * (G(leftHi) - G(x1));
    const rightLo = Math.max(x1, a);
    if (x2 > rightLo) area += 2 * (G(x2) - G(rightLo));
  }
  return area;
}

/**
 * Fraction of a body's disc above the skyline, from 0 to 1.
 *
 * Exact for the step-function skyline: the disc is cut into the wedges it overlaps, and in each
 * the area above that wedge's height is a closed-form circle-segment integral. The one
 * approximation is the flat tangent plane across the disc (error about rho^2 tan(el) / 2, below
 * 0.00001 degrees at the elevations the Sun and Earth reach from the south pole).
 */
export function visibleDiscFraction(
  direction: Direction,
  body: "sun" | "earth",
  skyline: Skyline,
  shift: SkylineShift = 0,
): number {
  const rho = discRadiusDeg(body, direction.distance_km);
  if (!(rho > 0) || !Number.isFinite(direction.el_deg)) return 0;
  const bands = wedgeBands(direction, rho, skyline, shift);
  // Exactly 1 or 0 when every wedge is wholly below or wholly above the disc; summing the pieces
  // would give 0.9999999999999999.
  if (bands.every((band) => band.threshold <= -rho)) return 1;
  if (bands.every((band) => band.threshold >= rho)) return 0;
  let area = 0;
  for (const band of bands) {
    area += bandArea(band.x1, band.x2, band.threshold, rho);
  }
  return Math.min(1, Math.max(0, area / (Math.PI * rho * rho)));
}

/**
 * How far the highest point of the disc rises above the skyline, degrees (negative: hidden).
 *
 * Over each overlapping wedge, the disc's top within that wedge minus the wedge's height; the
 * largest of these. It is positive exactly when some of the disc is visible, and with a flat
 * skyline at 0 it is the upper-edge elevation used by events.json (centre + radius). The event
 * search looks for its zero crossings.
 */
export function discClearanceDeg(
  direction: Direction,
  body: "sun" | "earth",
  skyline: Skyline,
  shift: SkylineShift = 0,
): number {
  const rho = discRadiusDeg(body, direction.distance_km);
  let best = -Infinity;
  for (const band of wedgeBands(direction, rho, skyline, shift)) {
    const nearest = band.x1 <= 0 && band.x2 >= 0 ? 0 : Math.min(Math.abs(band.x1), Math.abs(band.x2));
    best = Math.max(best, Math.sqrt(Math.max(0, rho * rho - nearest * nearest)) - band.threshold);
  }
  return best;
}

/**
 * Lit, blocked or uncertain, with the visible fraction as a range (rule approved 2026-11-15).
 *
 * `fraction_low` is the fraction against skyline + error, `fraction_high` against skyline - error.
 * Visible (lit) when `fraction_low > 0`: some of the disc is certainly clear. Blocked when
 * `fraction_high == 0`: none of it can be. Uncertain otherwise.
 */
export function classifyVisibility(
  direction: Direction,
  body: "sun" | "earth",
  skyline: Skyline,
): Visibility {
  const fractionLow = visibleDiscFraction(direction, body, skyline, 1);
  const fractionHigh = visibleDiscFraction(direction, body, skyline, -1);
  const status = fractionLow > 0 ? "visible" : fractionHigh === 0 ? "blocked" : "uncertain";
  return {
    fraction: visibleDiscFraction(direction, body, skyline, 0),
    fraction_low: fractionLow,
    fraction_high: fractionHigh,
    clearance_deg: discClearanceDeg(direction, body, skyline, 0),
    status,
  };
}
