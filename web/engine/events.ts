import type { EphemerisLabel, EventSet } from "./runtime-types";
import type { Skyline } from "./types";
import { directionFromBody, interpolateBody, timetableSpan } from "./astro";
import { degToRad } from "./math";
import { discMarginDeg, MARGIN_REACH_DEG, type SkylineShift } from "./visibility";

/**
 * Fastest angular motion of each body across the lunar sky, degrees per hour.
 *
 * Measured over the whole timetable (2026 to 2040) from 80°S to the pole: 0.511 for the Sun and
 * 0.113 for the Earth. The bounds keep a margin of 17 % and 32 %; `tests/audit/events.test.ts`
 * checks them against the timetable.
 */
export const ANGULAR_SPEED_BOUND_DEG_PER_H = { sun: 0.6, earth: 0.15 } as const;

/** Fastest change of either disc's angular radius, degrees per hour (measured: Earth 0.0008, Sun 0.00002). */
export const RADIUS_RATE_BOUND_DEG_PER_H = 0.002;

/**
 * Largest |elevation| of the Sun or the Earth the search accepts, degrees. From 80°S to the pole
 * the measured largest is 17.1° (the Earth). The rate bound uses it, so a larger one is refused.
 */
export const MAX_ABS_ELEVATION_DEG = 30;

/** Shortest step of the search, milliseconds: crossings are found to this resolution. */
export const MIN_STEP_MS = 1000;

/** Rise and set times of one function's zero crossings, UTC milliseconds in time order. */
export interface Crossings {
  rise_ms: number[];
  set_ms: number[];
}

/**
 * The fastest the margin of `discMarginDeg` can change, degrees per millisecond.
 *
 * The margin is the disc's radius minus a distance from its centre to a region fixed on the sky.
 * In the tangent plane, a centre moving at angular speed ω moves the distance by at most
 * cos(el)|d az/dt| + |d el/dt| ≤ 2ω. The plane's horizontal scale, cos(el), also changes as
 * the elevation changes, which moves points up to `MARGIN_REACH_DEG` away by at most
 * reach × tan(el) × ω more. The radius changes by at most `RADIUS_RATE_BOUND_DEG_PER_H`.
 */
export function marginRateBoundDegPerMs(body: "sun" | "earth"): number {
  const scaleTerm = degToRad(MARGIN_REACH_DEG) * Math.tan(degToRad(MAX_ABS_ELEVATION_DEG));
  return ((2 + scaleTerm) * ANGULAR_SPEED_BOUND_DEG_PER_H[body] + RADIUS_RATE_BOUND_DEG_PER_H) / 3_600_000;
}

/** Time between two samples where `f` changes between "above 0" and "not above 0", to 1 ms (bisection). */
function crossingTime(f: (t: number) => number, lo: number, hi: number, fLo: number): number {
  while (hi - lo > 1) {
    const mid = 0.5 * (lo + hi);
    const fMid = f(mid);
    if ((fMid > 0) === (fLo > 0)) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
    }
  }
  return Math.round(0.5 * (lo + hi));
}

/**
 * Every time a function goes above 0 (rise) or comes back to 0 or below (set) in a window.
 *
 * `f` must change by at most `rateDegPerMs` per millisecond. Then if |f(t)| = v, f keeps its
 * sign until at least t + v / rate, so the search jumps straight there: far from a crossing the
 * steps are long, near one they shrink. No step is shorter than `minStepMs`. Where the sign
 * differs at the two ends of a step, bisection finds the crossing to 1 ms.
 *
 * What this proves: every crossing is found, except that a stretch above or below 0 shorter than
 * `minStepMs` (1 s) can be missed. No 10-minute sampling, so no graze between samples can slip
 * through.
 *
 * @param f the function, degrees, of UTC milliseconds
 * @param startMs, endMs the window, UTC milliseconds
 * @param rateDegPerMs a proven bound on |df/dt|, degrees per millisecond
 * @param minStepMs the shortest step, milliseconds
 */
export function findCrossings(
  f: (t: number) => number,
  startMs: number,
  endMs: number,
  rateDegPerMs: number,
  minStepMs = MIN_STEP_MS,
): Crossings {
  if (!(rateDegPerMs > 0) || !(minStepMs > 0)) throw new RangeError("The rate bound and the shortest step must be positive");
  const result: Crossings = { rise_ms: [], set_ms: [] };
  let t = startMs;
  let v = f(t);
  while (t < endMs) {
    const next = Math.min(endMs, t + Math.max(minStepMs, Math.abs(v) / rateDegPerMs));
    const vNext = f(next);
    if ((v > 0) !== (vNext > 0)) {
      (vNext > 0 ? result.rise_ms : result.set_ms).push(crossingTime(f, t, next, v));
    }
    t = next;
    v = vNext;
  }
  return result;
}

/** A site for the event search; heights come from its skyline record (`elev_m`, `mast_m`). */
export interface EventSite {
  lat: number;
  lon: number;
}

/**
 * Margin of one body's disc against a site's skyline (`discMarginDeg`), degrees, as a function of
 * UTC ms. Positive when some of the disc is clear of the chosen skyline: nominal (0), or shifted
 * by the error bound and the flat-disc margins (+1 for certain, −1 for possible).
 * A direction higher than `MAX_ABS_ELEVATION_DEG` is refused, since the rate bound assumes it.
 */
export function marginFunction(
  values: Float32Array,
  label: EphemerisLabel,
  skyline: Skyline,
  site: EventSite,
  body: "sun" | "earth",
  shift: SkylineShift = 0,
): (timeMs: number) => number {
  const offset = body === "sun" ? 0 : 3;
  return (timeMs: number) => {
    const direction = directionFromBody(interpolateBody(values, label, timeMs, offset), site.lat, site.lon, skyline.elev_m, skyline.mast_m);
    if (!(Math.abs(direction.el_deg) <= MAX_ABS_ELEVATION_DEG)) {
      throw new RangeError(`The ${body} is at ${direction.el_deg} degrees, beyond the search's ${MAX_ABS_ELEVATION_DEG} degree bound`);
    }
    return discMarginDeg(direction, body, skyline, shift);
  };
}

/** Rises and sets of one body against one skyline (nominal or shifted) in a window. */
export function bodyCrossings(
  values: Float32Array,
  label: EphemerisLabel,
  skyline: Skyline,
  site: EventSite,
  body: "sun" | "earth",
  shift: SkylineShift,
  startMs: number,
  endMs: number,
): Crossings {
  return findCrossings(marginFunction(values, label, skyline, site, body, shift), startMs, endMs, marginRateBoundDegPerMs(body));
}

/** Clip a window to the timetable, so the search never asks for a time outside it. */
export function clipToTimetable(label: EphemerisLabel, startMs: number, endMs: number): { startMs: number; endMs: number } {
  const span = timetableSpan(label);
  return { startMs: Math.max(startMs, span.startMs), endMs: Math.min(endMs, span.endMs) };
}

/**
 * Sunrise, sunset, Earthrise and Earthset in a window, against the nominal skyline.
 *
 * Rise and set are when the first part of the disc appears above the skyline and when the last
 * part disappears. With a flat skyline at 0 and the eye on the ground this is the definition of
 * events.json: the upper edge crosses the level horizon. The window is clipped to the timetable.
 */
export function findEvents(
  values: Float32Array,
  label: EphemerisLabel,
  skyline: Skyline,
  site: EventSite,
  startMs: number,
  endMs: number,
): EventSet {
  const window = clipToTimetable(label, startMs, endMs);
  if (window.endMs <= window.startMs) return { sunrise: [], sunset: [], earthrise: [], earthset: [] };
  const sun = bodyCrossings(values, label, skyline, site, "sun", 0, window.startMs, window.endMs);
  const earth = bodyCrossings(values, label, skyline, site, "earth", 0, window.startMs, window.endMs);
  return { sunrise: sun.rise_ms, sunset: sun.set_ms, earthrise: earth.rise_ms, earthset: earth.set_ms };
}
