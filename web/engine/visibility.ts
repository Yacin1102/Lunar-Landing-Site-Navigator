import type { Direction, Visibility } from "./runtime-types";
import type { Skyline } from "./types";
import { discRadiusDeg } from "./astro";
import { degToRad, radToDeg } from "./math";

/**
 * Which skyline is the disc compared with: the nominal skyline (0), the skyline raised by its
 * error bound (+1, pessimistic) or lowered by it (-1, optimistic).
 *
 * The shifted skylines also carry the flat-disc margins of `flatDiscErrorDeg`, so a disc that is
 * clear of the +1 skyline is provably clear of the true one, and a disc hidden by the -1 skyline
 * is provably hidden.
 */
export type SkylineShift = -1 | 0 | 1;

/**
 * How far `discMarginDeg` looks around the disc's centre, degrees. Distances are capped here; every
 * skyline piece nearer than this is included, which keeps the margin continuous in time.
 */
export const MARGIN_REACH_DEG = 2;

/**
 * One piece of the step skyline, in the disc's tangent plane.
 *
 * `x1` to `x2` is its range across the sky (azimuth offset from the disc's centre times
 * cos(elevation)), and `threshold` is its height above the disc's centre, all in degrees.
 */
interface SkylinePiece {
  x1: number;
  x2: number;
  threshold: number;
}

/**
 * Proven bounds on how far the flat disc model can misplace a point of the disc, degrees.
 *
 * The engine draws the disc as a flat circle: a point at angular distance r and position angle θ
 * from the centre (θ from "up", towards increasing azimuth) is put at elevation e + r cos θ and
 * azimuth az + r sin θ / cos e. On the real sky its elevation and azimuth differ slightly. With
 * E = |e| + ρ and all angles in radians, for every point of a disc of radius ρ:
 *
 * - elevation error at most (sin|e| ρ²/2 + ρ³/6) / cos E. From the cosine rule
 *   sin el = sin e cos r + cos e sin r cos θ, the bounds cos a − cos b ≤ (b² − a²)/2 and
 *   0 ≤ sin(r c) − c sin r ≤ c r³/6, and the mean value theorem on sin.
 * - azimuth error at most ρ² sin E / cos² E + ρ³ / (6 cos e) + w³/(1 − w²), with w = ρ / cos E.
 *   From the sine rule sin Δaz = sin r sin θ / cos el, the mean value theorem on 1/cos, and
 *   asin w − w ≤ w³/(1 − w²).
 *
 * For the nearest Earth (356,400 km) at 17°, the highest it gets from 80°S, that is 0.0029° in
 * elevation and 0.0067° in azimuth; for the Sun at 11.6°, 0.00013° and 0.00028°. Measured on the
 * sphere, the true worst errors are within 4 % (elevation) and a factor 2.3 (azimuth) of these
 * (`tests/audit/disc.test.ts`). They widen the error bound for the lit and blocked answers only;
 * the nominal fraction keeps the flat model.
 *
 * @param elDeg elevation of the disc's centre, degrees
 * @param rhoDeg angular radius of the disc, degrees
 * @returns `{ el, az }`, the largest elevation and azimuth errors, degrees
 */
export function flatDiscErrorDeg(elDeg: number, rhoDeg: number): { el: number; az: number } {
  const r = degToRad(rhoDeg);
  const e = degToRad(Math.abs(elDeg));
  const bigE = e + r;
  if (!(bigE < degToRad(60))) throw new RangeError(`A disc at elevation ${elDeg} degrees is outside the range of the bounds`);
  const cosE = Math.cos(bigE);
  const el = (Math.sin(e) * r * r / 2 + r ** 3 / 6) / cosE;
  const w = r / cosE;
  const az = r * r * Math.sin(bigE) / (cosE * cosE) + r ** 3 / (6 * Math.cos(e)) + w ** 3 / (1 - w * w);
  return { el: radToDeg(el), az: radToDeg(az) };
}

/**
 * The pieces of the step skyline within `reach` degrees (across the sky) of a disc's centre.
 *
 * Entry `k` covers azimuths within half a step of `k * step` (a step function: never
 * interpolated). For shift 0 each wedge is one piece at its nominal height. For shift ±1 each
 * wedge is raised (+1) or lowered (−1) by its own error and by the flat-disc elevation error,
 * and every wedge boundary becomes a narrow piece, twice the flat-disc azimuth error wide, at the
 * higher (+1) or lower (−1) of its two neighbours. So a point the flat model places above the +1
 * pieces is truly above the skyline, and one it places below the −1 pieces is truly below it.
 * The list wraps across north.
 *
 * @param direction the disc's centre (azimuth and elevation, degrees)
 * @param rho the disc's angular radius, degrees
 * @param shift which skyline (see `SkylineShift`)
 * @param reach how far across the sky to collect pieces, degrees
 */
function skylinePieces(direction: Direction, rho: number, skyline: Skyline, shift: SkylineShift, reach: number): SkylinePiece[] {
  const step = skyline.az_step_deg;
  const n = skyline.skyline_deg.length;
  const cosEl = Math.max(Math.cos(degToRad(direction.el_deg)), 1e-9);
  const margin = shift === 0 ? { el: 0, az: 0 } : flatDiscErrorDeg(direction.el_deg, rho);
  if (margin.az >= step / 2) throw new RangeError("The flat-disc azimuth error is larger than half a skyline wedge");
  const height = (k: number) => {
    const index = ((k % n) + n) % n;
    return skyline.skyline_deg[index] + shift * skyline.skyline_err_deg[index];
  };
  const halfSpanAz = Math.min(180, reach / cosEl) + margin.az;
  const firstK = Math.round((direction.az_deg - halfSpanAz) / step);
  const lastK = Math.min(Math.round((direction.az_deg + halfSpanAz) / step), firstK + n - 1);
  const toX = (az: number) => (az - direction.az_deg) * cosEl;
  const pieces: SkylinePiece[] = [];
  const push = (az1: number, az2: number, h: number) => {
    const x1 = toX(az1);
    const x2 = toX(az2);
    if (x2 > x1 && x2 > -reach && x1 < reach) pieces.push({ x1, x2, threshold: h + shift * margin.el - direction.el_deg });
  };
  for (let k = firstK; k <= lastK; k += 1) {
    const lo = (k - 0.5) * step;
    const hi = (k + 0.5) * step;
    if (shift === 0) {
      push(lo, hi, height(k));
      continue;
    }
    push(lo + margin.az, hi - margin.az, height(k));
    if (k < lastK) {
      const pick = shift > 0 ? Math.max : Math.min;
      push(hi - margin.az, hi + margin.az, pick(height(k), height(k + 1)));
    }
  }
  return pieces;
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

/** The skyline pieces that overlap the disc, clipped to it. */
function piecesOnDisc(direction: Direction, rho: number, skyline: Skyline, shift: SkylineShift): SkylinePiece[] {
  return skylinePieces(direction, rho, skyline, shift, rho)
    .map((p) => ({ x1: Math.max(-rho, p.x1), x2: Math.min(rho, p.x2), threshold: p.threshold }))
    .filter((p) => p.x2 > p.x1);
}

/**
 * Fraction of a body's disc above the skyline, from 0 to 1.
 *
 * The disc is cut into the skyline pieces it overlaps, and in each the area above that piece's
 * height is a closed-form circle-segment integral, so the result is exact for the flat disc model.
 * For shift ±1 the pieces carry the proven flat-disc margins (`flatDiscErrorDeg`), so
 * `fraction > 0` against +1 proves some of the real disc is clear, and `fraction == 0` against −1
 * proves none of it is. The nominal fraction (shift 0) keeps the flat model: its points are
 * misplaced by at most those margins, and the flat circle's area differs from the true solid
 * angle by a relative ρ²/6 at most (below 0.00005).
 */
export function visibleDiscFraction(
  direction: Direction,
  body: "sun" | "earth",
  skyline: Skyline,
  shift: SkylineShift = 0,
): number {
  const rho = discRadiusDeg(body, direction.distance_km);
  if (!(rho > 0) || !Number.isFinite(direction.el_deg)) return 0;
  const pieces = piecesOnDisc(direction, rho, skyline, shift);
  // Exactly 1 or 0 when every piece is wholly below or wholly above the disc; summing the pieces
  // would give 0.9999999999999999.
  if (pieces.every((p) => p.threshold <= -rho)) return 1;
  if (pieces.every((p) => p.threshold >= rho)) return 0;
  let area = 0;
  for (const p of pieces) {
    area += bandArea(p.x1, p.x2, p.threshold, rho);
  }
  return Math.min(1, Math.max(0, area / (Math.PI * rho * rho)));
}

/**
 * How far the highest point of the disc rises above the skyline, degrees (negative: hidden).
 *
 * Over each overlapping piece, the disc's top within that piece minus the piece's height; the
 * largest of these. Positive exactly when some of the disc is visible, and with a flat skyline at
 * 0 it is the upper-edge elevation used by events.json (centre + radius). For display: it can
 * jump when a disc edge crosses a wedge boundary, so the event search follows `discMarginDeg`.
 */
export function discClearanceDeg(
  direction: Direction,
  body: "sun" | "earth",
  skyline: Skyline,
  shift: SkylineShift = 0,
): number {
  const rho = discRadiusDeg(body, direction.distance_km);
  let best = -Infinity;
  for (const p of piecesOnDisc(direction, rho, skyline, shift)) {
    const nearest = p.x1 <= 0 && p.x2 >= 0 ? 0 : Math.min(Math.abs(p.x1), Math.abs(p.x2));
    best = Math.max(best, Math.sqrt(Math.max(0, rho * rho - nearest * nearest)) - p.threshold);
  }
  return best;
}

/**
 * Signed angular margin of a disc against the skyline, degrees: positive when some of the disc is
 * clear, otherwise zero or negative. What the event search follows in time.
 *
 * The visible sky is the region above the (shifted) step skyline. The margin is the disc's radius
 * minus the signed distance from its centre to that region, in the tangent plane of
 * `visibleDiscFraction`: the distance to it when the centre is hidden, minus the distance to the
 * hidden region when the centre is clear. The disc overlaps the visible sky exactly when the
 * margin is positive, which is exactly when `visibleDiscFraction` for the same shift is above 0.
 *
 * Unlike the clearance, the margin does not jump when a disc edge crosses a wedge boundary: a
 * distance to a fixed region changes no faster than the point moves. That is what lets
 * `findCrossings` prove it skips no crossing. Distances are capped at `MARGIN_REACH_DEG`; every
 * piece nearer than that is included, so the cap does not break that property.
 *
 * @returns margin in degrees, between rho − MARGIN_REACH_DEG and rho + MARGIN_REACH_DEG
 */
export function discMarginDeg(
  direction: Direction,
  body: "sun" | "earth",
  skyline: Skyline,
  shift: SkylineShift = 0,
): number {
  const rho = discRadiusDeg(body, direction.distance_km);
  let toVisible = MARGIN_REACH_DEG;
  let toHidden = MARGIN_REACH_DEG;
  for (const p of skylinePieces(direction, rho, skyline, shift, MARGIN_REACH_DEG)) {
    const dx = p.x1 <= 0 && p.x2 >= 0 ? 0 : Math.min(Math.abs(p.x1), Math.abs(p.x2));
    toVisible = Math.min(toVisible, Math.hypot(dx, Math.max(0, p.threshold)));
    toHidden = Math.min(toHidden, Math.hypot(dx, Math.max(0, -p.threshold)));
  }
  const signedDistance = toVisible > 0 ? toVisible : -toHidden;
  return rho - signedDistance;
}

/**
 * Lit, blocked or uncertain, with the visible fraction as a range (rule approved 2026-11-15).
 *
 * `fraction_low` is the fraction against skyline + error, `fraction_high` against skyline − error,
 * both with the flat-disc margins. Visible (lit) when `fraction_low > 0`: some of the disc is
 * certainly clear. Blocked when `fraction_high == 0`: none of it can be. Uncertain otherwise.
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
