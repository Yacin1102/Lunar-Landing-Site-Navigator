import { classifyVisibility } from "../engine/visibility";
import { directionsAt, discRadiusDeg, skylineAt, timetableSpan } from "../engine/astro";
import { evaluateSite } from "../engine/evaluate";
import { panelPowerW, simulateBattery } from "../engine/power";
import type { DataBundle, Direction, MissionMetrics, Visibility } from "../engine/runtime-types";
import type { Site, Skyline } from "../engine/types";

export interface TimelinePoint {
  timeMs: number;
  sun: Direction;
  earth: Direction;
  sunVisibility?: Visibility;
  earthVisibility?: Visibility;
  sunFraction: number;
  earthFraction: number;
  sunStatus: "visible" | "blocked" | "uncertain";
  earthStatus: "visible" | "blocked" | "uncertain";
  batteryWh: number;
}

export interface ScenarioSummary {
  site: Site;
  skyline?: Skyline;
  points: TimelinePoint[];
  sunlightHours: number;
  timeToSunsetMs?: number;
  timeToEarthsetMs?: number;
  lowestBatteryWh: number;
  unavailable?: string;
}

/** Build a fixed-width timeline around a selected instant for the chart and scrubber. */
export function timelineBounds(centerMs: number, spanDays: number): { startMs: number; endMs: number; stepMs: number } {
  const spanMs = spanDays * 86400000;
  const startMs = centerMs - spanMs / 2;
  const endMs = centerMs + spanMs / 2;
  return { startMs, endMs, stepMs: spanDays <= 2 ? 30 * 60000 : 6 * 3600000 };
}

/**
 * Sample the existing engine for the fixed chart window and evaluate the selected instant exactly.
 *
 * `windowCenterMs` anchors the plotted window; `selectedMs` is the moving cursor inside it.
 * Keeping these separate prevents the chart from recentering on every scrub or play tick.
 */
export function buildTimeline(
  bundle: DataBundle,
  site: Site,
  skyline: Skyline | undefined,
  windowCenterMs: number,
  spanDays: number,
  selectedMs = windowCenterMs,
): ScenarioSummary {
  if (!skyline) {
    return { site, points: [], sunlightHours: 0, lowestBatteryWh: 0, unavailable: "Terrain not included; verdict unavailable." };
  }
  const bounds = timelineBounds(windowCenterMs, spanDays);
  const table = timetableSpan(bundle.ephemeris.label);
  const points: TimelinePoint[] = [];
  // Only times the timetable covers: near its ends the window is cut rather than extrapolated.
  for (let timeMs = Math.max(bounds.startMs, table.startMs); timeMs <= Math.min(bounds.endMs, table.endMs); timeMs += bounds.stepMs) {
    const directions = directionsAt(bundle.ephemeris.values, bundle.ephemeris.label, timeMs, site.lat, site.lon, skyline.elev_m, skyline.mast_m);
    const sun = classifyVisibility(directions.sun, "sun", skyline);
    const earth = classifyVisibility(directions.earth, "earth", skyline);
    points.push({
      timeMs,
      sun: directions.sun,
      earth: directions.earth,
      sunVisibility: sun,
      earthVisibility: earth,
      sunFraction: sun.fraction,
      earthFraction: earth.fraction,
      sunStatus: sun.status,
      earthStatus: earth.status,
      batteryWh: 0,
    });
  }
  const battery = simulateBattery(
    points.map((point) => ({ time_ms: point.timeMs, sun: point.sun, visible_fraction: point.sunFraction })),
    { type: "tracking", area_m2: 4, efficiency: 0.25 },
    { capacity_Wh: 2400, initial_Wh: 1800, load_W: 120 },
  );
  battery.charge_Wh.forEach((charge, index) => {
    points[index].batteryWh = charge.charge_Wh;
  });
  // Sunlight hours and countdowns come from the engine's exact crossings, counted from the chosen
  // time; sampling the chart points instead missed short stretches and could return a sunset
  // from before the chosen time.
  const { metrics } = evaluateSite(bundle.ephemeris.values, bundle.ephemeris.label, skyline, site,
    Math.min(Math.max(selectedMs, table.startMs), table.endMs), bounds.startMs, bounds.endMs);
  return {
    site,
    skyline,
    points,
    sunlightHours: metrics.sunlight_hours,
    timeToSunsetMs: metrics.time_to_next_sunset_ms,
    timeToEarthsetMs: metrics.time_to_next_earthset_ms,
    lowestBatteryWh: battery.lowest_charge_Wh,
  };
}

/** Return the screen-space elevation range needed to draw both body paths. */
export function elevationRange(summary: ScenarioSummary): { min: number; max: number } {
  const values = summary.points.flatMap((point) => [point.sun.el_deg, point.earth.el_deg, 0]);
  return { min: Math.min(...values, -2), max: Math.max(...values, 2) };
}

/** Convert an azimuth/elevation to an SVG point in a sky-view panel. */
export function skyPoint(azimuth: number, elevation: number, width: number, height: number, minEl: number, maxEl: number): { x: number; y: number } {
  return {
    x: (azimuth / 360) * width,
    y: height - ((elevation - minEl) / (maxEl - minEl)) * height,
  };
}

/** Find the skyline elevation and disc scale used by the sky-view overlay. */
export function skyBodySize(direction: Direction, body: "sun" | "earth", height: number, minEl: number, maxEl: number): number {
  return Math.max(3, (discRadiusDeg(body, direction.distance_km) / (maxEl - minEl)) * height);
}

/** Return the skyline's step-function elevation at an azimuth for a tooltip. */
export function skyElevation(skyline: Skyline, azimuth: number): number {
  return skylineAt(skyline.skyline_deg, skyline.az_step_deg, azimuth);
}
