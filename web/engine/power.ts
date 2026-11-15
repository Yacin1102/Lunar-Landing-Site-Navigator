import type { Direction } from "./runtime-types";
import { clamp, degToRad, dot, normalize } from "./math";

/** The solar constant at 1 AU, W/m^2 (IAU 2015 nominal value). */
export const SOLAR_CONSTANT_W_M2 = 1361;
/** The astronomical unit, km (IAU 2012). */
export const AU_KM = 149_597_870.7;

/**
 * Sunlight reaching a site, W/m^2 on a surface facing the Sun: 1361 x (1 AU / d)^2 x the visible
 * fraction of the disc (0 to 1), with `d` the eye-to-Sun distance in km.
 */
export function solarIrradianceWm2(distanceKm: number, visibleFraction: number): number {
  if (!(distanceKm > 0)) return 0;
  return SOLAR_CONSTANT_W_M2 * (AU_KM / distanceKm) ** 2 * clamp(visibleFraction, 0, 1);
}

/** Calculate the cosine of incidence for a flat panel facing local up. */
export function flatPanelIncidence(elevationDeg: number): number {
  return Math.max(0, Math.sin(degToRad(elevationDeg)));
}

/** A Sun-tracking panel turns its normal toward the Sun, so incidence is one when lit. */
export function trackingPanelIncidence(visibleFraction: number): number {
  return visibleFraction > 0 ? 1 : 0;
}

/**
 * Cosine of incidence on a fixed panel, clamped at 0 (light from behind gives nothing).
 *
 * `tilt_deg` is the panel's angle from horizontal, as in solar engineering: 0 lies flat (facing
 * up), 90 stands vertical. `az_deg` is the direction the panel faces, from north clockwise. The
 * panel's normal therefore has elevation 90 - tilt.
 */
export function fixedPanelIncidence(
  sun: Pick<Direction, "az_deg" | "el_deg">,
  panel: { tilt_deg: number; az_deg: number },
): number {
  const normalEl = 90 - panel.tilt_deg;
  const sunVector = {
    x: Math.cos(degToRad(sun.el_deg)) * Math.sin(degToRad(sun.az_deg)),
    y: Math.cos(degToRad(sun.el_deg)) * Math.cos(degToRad(sun.az_deg)),
    z: Math.sin(degToRad(sun.el_deg)),
  };
  const normal = {
    x: Math.cos(degToRad(normalEl)) * Math.sin(degToRad(panel.az_deg)),
    y: Math.cos(degToRad(normalEl)) * Math.cos(degToRad(panel.az_deg)),
    z: Math.sin(degToRad(normalEl)),
  };
  return Math.max(0, dot(normalize(sunVector), normalize(normal)));
}

/** Supported panel geometry and its user-facing settings. */
export type PanelSettings =
  | { type: "flat"; area_m2: number; efficiency: number }
  | { type: "tracking"; area_m2: number; efficiency: number }
  | { type: "fixed"; area_m2: number; efficiency: number; tilt_deg: number; az_deg: number };

/** Calculate electrical power for one Sun direction and visible disc fraction. */
export function panelPowerW(
  sun: Direction,
  visibleFraction: number,
  panel: PanelSettings,
): number {
  const incidence = panel.type === "flat"
    ? flatPanelIncidence(sun.el_deg)
    : panel.type === "tracking"
      ? trackingPanelIncidence(visibleFraction)
      : fixedPanelIncidence(sun, panel);
  return solarIrradianceWm2(sun.distance_km, visibleFraction) * panel.area_m2 * panel.efficiency * incidence;
}

/** One power sample used by the battery integrator. */
export interface PowerSample {
  time_ms: number;
  sun: Direction;
  visible_fraction: number;
}

/** Battery settings and the constant mission load. */
export interface BatterySettings {
  capacity_Wh: number;
  initial_Wh: number;
  load_W: number;
}

/**
 * Integrate generation and load over the samples, Wh.
 *
 * Each step uses the power at its start for the whole step (hours = time difference / 3.6e6).
 * The charge is kept between 0 and the capacity. The run-out time is the moment within a step
 * at which the charge reaches 0, by straight-line interpolation of that step. Settings must be
 * finite, with capacity above 0 and load at or above 0.
 */
export function simulateBattery(
  samples: PowerSample[],
  panel: PanelSettings,
  battery: BatterySettings,
): {
  energy_produced_Wh: number;
  charge_Wh: Array<{ time_ms: number; charge_Wh: number }>;
  lowest_charge_Wh: number;
  battery_runs_out_ms?: number;
} {
  if (![battery.capacity_Wh, battery.initial_Wh, battery.load_W, panel.area_m2, panel.efficiency].every(Number.isFinite)
    || battery.capacity_Wh <= 0 || battery.load_W < 0 || panel.area_m2 < 0 || panel.efficiency < 0) {
    throw new RangeError("Battery and panel settings must be finite, with capacity > 0 and load, area and efficiency >= 0");
  }
  let charge = clamp(battery.initial_Wh, 0, battery.capacity_Wh);
  if (samples.length === 0) {
    return { energy_produced_Wh: 0, charge_Wh: [], lowest_charge_Wh: charge };
  }
  let generated = 0;
  let lowest = charge;
  let runout: number | undefined;
  const chargeHistory = [{ time_ms: samples[0].time_ms, charge_Wh: charge }];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const hours = Math.max(0, current.time_ms - previous.time_ms) / 3600000;
    const powerW = panelPowerW(previous.sun, previous.visible_fraction, panel);
    const produced = powerW * hours;
    generated += produced;
    const netW = powerW - battery.load_W;
    const unclamped = charge + netW * hours;
    if (unclamped <= 0 && charge > 0 && runout === undefined) {
      runout = previous.time_ms + (charge / -netW) * 3600000;
    } else if (unclamped <= 0 && charge === 0 && netW < 0 && runout === undefined) {
      runout = previous.time_ms;
    }
    charge = clamp(unclamped, 0, battery.capacity_Wh);
    lowest = Math.min(lowest, charge);
    chargeHistory.push({ time_ms: current.time_ms, charge_Wh: charge });
  }
  return {
    energy_produced_Wh: generated,
    charge_Wh: chargeHistory,
    lowest_charge_Wh: lowest,
    battery_runs_out_ms: runout,
  };
}
