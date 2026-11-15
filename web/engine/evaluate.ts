import type { Direction, EphemerisLabel, EventSet, MissionMetrics, Visibility } from "./runtime-types";
import type { Skyline } from "./types";
import { directionsAt } from "./astro";
import { classifyVisibility } from "./visibility";
import { clearanceFunction, clipToTimetable, findCrossings, findEvents, type EventSite } from "./events";
import { calculateMetrics, intervalsFromCrossings } from "./metrics";

/** Everything the dashboard needs for one site, time and window. */
export interface Evaluation {
  directions: { sun: Direction; earth: Direction };
  sunVisibility: Visibility;
  earthVisibility: Visibility;
  events: EventSet;
  metrics: MissionMetrics;
}

/**
 * Evaluate a site at a chosen time and over a window. This is what the Web Worker runs; it is a
 * plain function so tests can call it directly.
 *
 * The eye's height comes from the skyline record (`elev_m + mast_m`): `sites.json` has no
 * heights, and the skyline was computed for exactly that eye. The window is clipped to the
 * timetable. Lit and uncertain stretches are exact intervals between crossings of the disc
 * against skyline + error and skyline - error, not samples.
 */
export function evaluateSite(
  values: Float32Array,
  label: EphemerisLabel,
  skyline: Skyline,
  site: EventSite,
  timeMs: number,
  startMs: number,
  endMs: number,
): Evaluation {
  const directions = directionsAt(values, label, timeMs, site.lat, site.lon, skyline.elev_m, skyline.mast_m);
  const window = clipToTimetable(label, startMs, endMs);
  const events = findEvents(values, label, skyline, site, window.startMs, window.endMs);
  const intervals = (body: "sun" | "earth", shift: 1 | -1) => {
    const f = clearanceFunction(values, label, skyline, site, body, shift);
    if (window.endMs <= window.startMs) return [];
    return intervalsFromCrossings(f(window.startMs) > 0, findCrossings(f, window.startMs, window.endMs), window.startMs, window.endMs);
  };
  const metrics = calculateMetrics(events, timeMs, window.startMs, window.endMs,
    intervals("sun", 1), intervals("sun", -1), intervals("earth", 1));
  return {
    directions,
    sunVisibility: classifyVisibility(directions.sun, "sun", skyline),
    earthVisibility: classifyVisibility(directions.earth, "earth", skyline),
    events,
    metrics,
  };
}
