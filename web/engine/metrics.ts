import type { EventSet, MissionMetrics, TimeInterval } from "./runtime-types";
import type { Crossings } from "./events";

/**
 * The stretches of a window during which a condition holds, from its state at the start and its
 * crossings (rises switch it on, sets switch it off). Exact to the crossing times, not sampled.
 */
export function intervalsFromCrossings(onAtStart: boolean, crossings: Crossings, startMs: number, endMs: number): TimeInterval[] {
  const switches = [
    ...crossings.rise_ms.map((t) => ({ t, on: true })),
    ...crossings.set_ms.map((t) => ({ t, on: false })),
  ].filter((s) => s.t > startMs && s.t < endMs).sort((a, b) => a.t - b.t);
  const intervals: TimeInterval[] = [];
  let on = onAtStart;
  let since = startMs;
  for (const s of switches) {
    if (s.on === on) continue;
    if (on) intervals.push({ start_ms: since, end_ms: s.t });
    on = s.on;
    since = s.t;
  }
  if (on && endMs > since) intervals.push({ start_ms: since, end_ms: endMs });
  return intervals;
}

/** Total length of a list of intervals, milliseconds. */
export function totalMs(intervals: TimeInterval[]): number {
  return intervals.reduce((sum, i) => sum + (i.end_ms - i.start_ms), 0);
}

/** Overlap of two sorted interval lists. */
export function intersectIntervals(a: TimeInterval[], b: TimeInterval[]): TimeInterval[] {
  const out: TimeInterval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start_ms, b[j].start_ms);
    const end = Math.min(a[i].end_ms, b[j].end_ms);
    if (end > start) out.push({ start_ms: start, end_ms: end });
    if (a[i].end_ms < b[j].end_ms) i += 1;
    else j += 1;
  }
  return out;
}

/** Longest gap in a window not covered by the intervals, milliseconds. */
export function longestGapMs(intervals: TimeInterval[], startMs: number, endMs: number): number {
  let longest = 0;
  let cursor = startMs;
  for (const i of intervals) {
    longest = Math.max(longest, i.start_ms - cursor);
    cursor = Math.max(cursor, i.end_ms);
  }
  return Math.max(longest, endMs - cursor);
}

/**
 * Mission-planning durations for a window.
 *
 * `sunLit` are the stretches of certain sunlight (fraction against skyline + error above 0),
 * `sunPossible` those where the Sun could be visible (against skyline - error), `earthLit` the
 * stretches with the Earth certainly in view. Countdowns run from `timeMs` to the next nominal
 * sunset or Earthset event.
 */
export function calculateMetrics(
  events: EventSet,
  timeMs: number,
  startMs: number,
  endMs: number,
  sunLit: TimeInterval[],
  sunPossible: TimeInterval[],
  earthLit: TimeInterval[],
): MissionMetrics {
  const sunset = events.sunset.find((time) => time >= timeMs);
  const earthset = events.earthset.find((time) => time >= timeMs);
  return {
    time_to_next_sunset_ms: sunset === undefined ? undefined : sunset - timeMs,
    time_to_next_earthset_ms: earthset === undefined ? undefined : earthset - timeMs,
    sunlight_hours: totalMs(sunLit) / 3600000,
    uncertain_sun_hours: (totalMs(sunPossible) - totalMs(sunLit)) / 3600000,
    earth_visible_hours: totalMs(earthLit) / 3600000,
    longest_night_ms: longestGapMs(sunLit, startMs, endMs),
    both_visible_windows: intersectIntervals(sunLit, earthLit),
  };
}
