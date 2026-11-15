import type { EphemerisLabel, EventSet } from "./runtime-types";
import type { Skyline } from "./types";
import { directionFromBody, interpolateBody, timetableSpan } from "./astro";
import { discClearanceDeg, type SkylineShift } from "./visibility";

/** Spacing of the first scan, milliseconds. Short grazes between samples are caught by the turning-point search. */
export const SCAN_STEP_MS = 10 * 60 * 1000;

/** Rise and set times of one function's zero crossings, UTC milliseconds in time order. */
export interface Crossings {
  rise_ms: number[];
  set_ms: number[];
}

/** Time between two samples where `f` changes sign, to 1 ms (bisection). */
function crossingTime(f: (t: number) => number, lo: number, hi: number, fLo: number): number {
  while (hi - lo > 1) {
    const mid = 0.5 * (lo + hi);
    const fMid = f(mid);
    if ((fMid < 0) === (fLo < 0)) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
    }
  }
  return Math.round(0.5 * (lo + hi));
}

/** Highest (sign = +1) or lowest (sign = -1) point of `f` between two times, to about 1 s (ternary search). */
function turningPoint(f: (t: number) => number, a: number, b: number, sign: number): [number, number] {
  while (b - a > 1000) {
    const third = (b - a) / 3;
    const m1 = a + third;
    const m2 = b - third;
    if (sign * f(m1) < sign * f(m2)) a = m1;
    else b = m2;
  }
  const t = 0.5 * (a + b);
  return [t, f(t)];
}

/**
 * Every zero crossing of `f` (degrees above a horizon, as a function of UTC ms) in a window.
 *
 * A port of `find_events` in python/lunar_engine/events_reference.py, which made events.json.
 * 1. Sample every 10 minutes.
 * 2. Where three samples show a turning point (a local top or bottom), find it; if it is on the
 *    other side of zero from the middle sample, the curve poked through zero between samples,
 *    and the turning point becomes an extra split point. The first and last interval have no
 *    neighbour on one side, so they are searched directly.
 * 3. Between consecutive split points of opposite sign, bisect to the crossing.
 * A crossing from below to above is a rise, the other way a set.
 */
export function findCrossings(f: (t: number) => number, startMs: number, endMs: number, scanStepMs = SCAN_STEP_MS): Crossings {
  const times: number[] = [];
  for (let t = startMs; t < endMs; t += scanStepMs) times.push(t);
  times.push(endMs);
  const values = times.map(f);
  const points: Array<[number, number]> = times.map((t, i) => [t, values[i]]);
  if (times.length >= 2) {
    for (const [a, b] of [[0, 1], [times.length - 2, times.length - 1]]) {
      for (const sign of [1, -1]) {
        const [tTurn, vTurn] = turningPoint(f, times[a], times[b], sign);
        if (Math.min(tTurn - times[a], times[b] - tTurn) > 2000
          && (vTurn < 0) !== (values[a] < 0) && (vTurn < 0) !== (values[b] < 0)) {
          points.push([tTurn, vTurn]);
        }
      }
    }
  }
  for (let i = 1; i < times.length - 1; i += 1) {
    const [left, mid, right] = [values[i - 1], values[i], values[i + 1]];
    for (const sign of [1, -1]) {
      const isTurn = sign * mid >= sign * left && sign * mid >= sign * right;
      if (isTurn && !(left === mid && mid === right)) {
        const [tTurn, vTurn] = turningPoint(f, times[i - 1], times[i + 1], sign);
        if ((vTurn < 0) !== (mid < 0)) points.push([tTurn, vTurn]);
      }
    }
  }
  points.sort((p, q) => p[0] - q[0]);
  const result: Crossings = { rise_ms: [], set_ms: [] };
  for (let i = 0; i + 1 < points.length; i += 1) {
    const [tA, fA] = points[i];
    const [tB, fB] = points[i + 1];
    if ((fA < 0) !== (fB < 0)) {
      (fA < 0 ? result.rise_ms : result.set_ms).push(crossingTime(f, tA, tB, fA));
    }
  }
  return result;
}

/** A site for the event search; heights come from its skyline record (`elev_m`, `mast_m`). */
export interface EventSite {
  lat: number;
  lon: number;
}

/**
 * Clearance of one body's disc above a site's skyline, degrees, as a function of UTC ms.
 * Positive when some of the disc is visible against the chosen skyline (nominal, or shifted by
 * the error bound).
 */
export function clearanceFunction(
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
    return discClearanceDeg(direction, body, skyline, shift);
  };
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
  const sun = findCrossings(clearanceFunction(values, label, skyline, site, "sun"), window.startMs, window.endMs);
  const earth = findCrossings(clearanceFunction(values, label, skyline, site, "earth"), window.startMs, window.endMs);
  return { sunrise: sun.rise_ms, sunset: sun.set_ms, earthrise: earth.rise_ms, earthset: earth.set_ms };
}
