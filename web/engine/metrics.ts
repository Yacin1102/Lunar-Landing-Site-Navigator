import type { EventSet, MissionMetrics, Visibility } from "./types";

/** Convert event lists and sampled visibility into mission-planning durations. */
export function calculateMetrics(
  events: EventSet,
  startMs: number,
  endMs: number,
  sunVisibleAt: (timeMs: number) => boolean,
  earthVisibleAt: (timeMs: number) => boolean,
): MissionMetrics {
  const sunset = events.sunset.find((time) => time >= startMs);
  const earthset = events.earthset.find((time) => time >= startMs);
  const sampleStep = 10 * 60 * 1000;
  let sunlightMs = 0;
  let currentNightStart: number | undefined;
  let longestNightMs = 0;
  const bothVisibleWindows: MissionMetrics["both_visible_windows"] = [];
  let bothStart: number | undefined;
  let previousSun = false;
  let previousBoth = false;
  for (let time = startMs; time < endMs; time += sampleStep) {
    const sun = sunVisibleAt(time);
    const earth = earthVisibleAt(time);
    const both = sun && earth;
    if (sun) sunlightMs += Math.min(sampleStep, endMs - time);
    if (!sun && previousSun) currentNightStart = time;
    if (sun && !previousSun && currentNightStart !== undefined) {
      longestNightMs = Math.max(longestNightMs, time - currentNightStart);
      currentNightStart = undefined;
    }
    if (both && !previousBoth) bothStart = time;
    if (!both && previousBoth && bothStart !== undefined) {
      bothVisibleWindows.push({ start_ms: bothStart, end_ms: time });
      bothStart = undefined;
    }
    previousSun = sun;
    previousBoth = both;
  }
  if (!previousSun && currentNightStart !== undefined) longestNightMs = Math.max(longestNightMs, endMs - currentNightStart);
  if (previousBoth && bothStart !== undefined) bothVisibleWindows.push({ start_ms: bothStart, end_ms: endMs });
  return {
    time_to_next_sunset_ms: sunset === undefined ? undefined : sunset - startMs,
    time_to_next_earthset_ms: earthset === undefined ? undefined : earthset - startMs,
    sunlight_hours: sunlightMs / 3600000,
    longest_night_ms: longestNightMs,
    both_visible_windows: bothVisibleWindows,
  };
}
