import type {
  EphemLabel,
  Manifest,
  ShadeLabel,
  Site,
  Skyline,
  TerrainLabel,
} from "./types";

/** A three-dimensional vector used by the browser astronomy calculations. */
export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/** A body's local direction as seen from the observer. */
export interface Direction {
  az_deg: number;
  el_deg: number;
  distance_km: number;
}

/**
 * The result of comparing a body disc with a skyline and its error bound.
 * Fractions are 0 to 1; `fraction_low` is against skyline + error, `fraction_high` against
 * skyline - error, `fraction` against the nominal skyline. `clearance_deg` is how far the top
 * of the disc rises above the nominal skyline (negative: hidden).
 */
export interface Visibility {
  fraction: number;
  fraction_low: number;
  fraction_high: number;
  clearance_deg: number;
  status: "visible" | "blocked" | "uncertain";
}

/** The four event streams returned for a search window. */
export interface EventSet {
  sunrise: number[];
  sunset: number[];
  earthrise: number[];
  earthset: number[];
}

/** A stretch of time, UTC milliseconds, start included and end excluded. */
export interface TimeInterval {
  start_ms: number;
  end_ms: number;
}

/**
 * Mission-planning durations for a window. "Lit" means certainly lit (the approved rule:
 * `fraction_low > 0`); "uncertain" hours could be either way. A night is a stretch without
 * certain sunlight. Countdowns run from the chosen time, not from the window's start.
 */
export interface MissionMetrics {
  time_to_next_sunset_ms?: number;
  time_to_next_earthset_ms?: number;
  sunlight_hours: number;
  uncertain_sun_hours: number;
  earth_visible_hours: number;
  longest_night_ms: number;
  both_visible_windows: TimeInterval[];
}

/** A terrain patch with its contract label and decoded samples. */
export interface TerrainPatch {
  label: TerrainLabel;
  values: Float32Array;
}

/** A shade grid with its contract label and decoded binary arrays. */
export interface ShadeGrid {
  label: ShadeLabel;
  skyline: Int16Array;
  normal: Float32Array;
}

/** All prepared files needed by the browser for a selected site. */
export interface DataBundle {
  manifest: Manifest;
  sites: Site[];
  ephemeris: { label: EphemerisLabel; values: Float32Array };
  skylines: Map<string, Skyline>;
  terrain: Map<string, TerrainPatch>;
  shade: Map<string, ShadeGrid>;
}

/** Allow deployment to switch from the checked-in mock folder to real data. */
export function getDataFolder(): string {
  return (import.meta.env.VITE_DATA_FOLDER as string | undefined) ?? "/data-mock";
}

/** Keep the generated label name available to calculation modules without editing it. */
export type EphemerisLabel = Omit<EphemLabel, "t0_ms"> & { t0_ms: number };
