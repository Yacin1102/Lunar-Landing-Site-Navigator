import type { Direction } from "./runtime-types";
import { clamp, degToRad, dot, normalize } from "./math";

/** Solar irradiance at one lunar site after inverse-square distance scaling. */
export function solarIrradianceWm2(distanceKm: number, visibleFraction: number): number {
  const astronomicalUnitKm = 149_597_870.7;
  return 1361 * (astronomicalUnitKm / distanceKm) ** 2 * clamp(visibleFraction, 0, 1);
}

/** Calculate the cosine of incidence for a flat panel facing local up. */
export function flatPanelIncidence(elevationDeg: number): number {
  return Math.max(0, Math.sin(degToRad(elevationDeg)));
}

/** A Sun-tracking panel turns its normal toward the Sun, so incidence is one when lit. */
export function trackingPanelIncidence(visibleFraction: number): number {
  return visibleFraction > 0 ? 1 : 0;
}

/** Calculate fixed-panel incidence from tilt above the horizon and azimuth clockwise from north. */
export function fixedPanelIncidence(
  sun: Pick<Direction, "az_deg" | "el_deg">,
  panel: { tilt_deg: number; az_deg: number },
): number {
  const sunVector = {
    x: Math.cos(degToRad(sun.el_deg)) * Math.sin(degToRad(sun.az_deg)),
    y: Math.cos(degToRad(sun.el_deg)) * Math.cos(degToRad(sun.az_deg)),
    z: Math.sin(degToRad(sun.el_deg)),
  };
  const normal = {
    x: Math.cos(degToRad(panel.tilt_deg)) * Math.sin(degToRad(panel.az_deg)),
    y: Math.cos(degToRad(panel.tilt_deg)) * Math.cos(degToRad(panel.az_deg)),
    z: Math.sin(degToRad(panel.tilt_deg)),
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

/** Integrate generation and load, reporting charge history, minimum, and brownout time. */
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
  if (samples.length === 0) {
    return { energy_produced_Wh: 0, charge_Wh: [], lowest_charge_Wh: battery.initial_Wh };
  }
  let charge = clamp(battery.initial_Wh, 0, battery.capacity_Wh);
  let generated = 0;
  let lowest = charge;
  let runout: number | undefined;
  const chargeHistory = [{ time_ms: samples[0].time_ms, charge_Wh: charge }];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const hours = Math.max(0, current.time_ms - previous.time_ms) / 3600000;
    const produced = panelPowerW(previous.sun, previous.visible_fraction, panel) * hours;
    generated += produced;
    charge = clamp(charge + produced - battery.load_W * hours, 0, battery.capacity_Wh);
    if (charge === 0 && runout === undefined) runout = current.time_ms;
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
