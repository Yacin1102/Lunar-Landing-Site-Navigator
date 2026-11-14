import { classifyVisibility } from "../engine/visibility";
import { directionsAt, discRadiusDeg, skylineAt } from "../engine/astro";
import { panelPowerW, simulateBattery } from "../engine/power";
import type { DataBundle, Direction, MissionMetrics } from "../engine/runtime-types";
import type { Site, Skyline } from "../engine/types";

export interface TimelinePoint {
  timeMs: number;
  sun: Direction;
  earth: Direction;
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

/** Convert a date into the browser input format without losing the UTC instant. */
export function toDateTimeInputValue(timeMs: number): string {
  const date = new Date(timeMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** Convert a browser date input into UTC milliseconds. */
export function fromDateTimeInputValue(value: string): number {
  return Date.parse(`${value}:00Z`);
}

/** Format a duration as a compact countdown for a mission planner. */
export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return "No crossing in range";
  const totalMinutes = Math.max(0, Math.round(durationMs / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return `${days ? `${days}d ` : ""}${hours}h ${minutes}m`;
}

/** Build a fixed-width timeline around a selected instant for the chart and scrubber. */
export function timelineBounds(centerMs: number, spanDays: number): { startMs: number; endMs: number; stepMs: number } {
  const spanMs = spanDays * 86400000;
  const startMs = centerMs - spanMs / 2;
  const endMs = centerMs + spanMs / 2;
  return { startMs, endMs, stepMs: spanDays <= 2 ? 30 * 60000 : 6 * 3600000 };
}

/** Sample the existing engine for directions, disc visibility, and battery charge. */
export function buildTimeline(
  bundle: DataBundle,
  site: Site,
  skyline: Skyline | undefined,
  centerMs: number,
  spanDays: number,
): ScenarioSummary {
  if (!skyline) {
    return { site, points: [], sunlightHours: 0, lowestBatteryWh: 0, unavailable: "Terrain not included; verdict unavailable." };
  }
  const bounds = timelineBounds(centerMs, spanDays);
  const points: TimelinePoint[] = [];
  for (let timeMs = bounds.startMs; timeMs <= bounds.endMs; timeMs += bounds.stepMs) {
    const directions = directionsAt(bundle.ephemeris.values, bundle.ephemeris.label, timeMs, site.lat, site.lon, skyline.elev_m, skyline.mast_m);
    const sun = classifyVisibility(directions.sun, "sun", skyline);
    const earth = classifyVisibility(directions.earth, "earth", skyline);
    points.push({
      timeMs,
      sun: directions.sun,
      earth: directions.earth,
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
  let sunlightHours = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index - 1].sunStatus === "visible") sunlightHours += (points[index].timeMs - points[index - 1].timeMs) / 3600000;
  }
  const sunset = points.find((point, index) => index > 0 && points[index - 1].sunStatus === "visible" && point.sunStatus !== "visible")?.timeMs;
  const earthset = points.find((point, index) => index > 0 && points[index - 1].earthStatus === "visible" && point.earthStatus !== "visible")?.timeMs;
  return {
    site,
    skyline,
    points,
    sunlightHours,
    timeToSunsetMs: sunset === undefined ? undefined : sunset - centerMs,
    timeToEarthsetMs: earthset === undefined ? undefined : earthset - centerMs,
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
