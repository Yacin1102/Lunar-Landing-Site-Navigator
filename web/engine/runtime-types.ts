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

/** The result of comparing a body disc with a skyline. */
export interface Visibility {
  fraction: number;
  center_clearance_deg: number;
  upper_edge_clearance_deg: number;
  status: "visible" | "blocked" | "uncertain";
}

/** The four event streams returned for a search window. */
export interface EventSet {
  sunrise: number[];
  sunset: number[];
  earthrise: number[];
  earthset: number[];
}

/** Mission-planning durations and overlapping visibility windows. */
export interface MissionMetrics {
  time_to_next_sunset_ms?: number;
  time_to_next_earthset_ms?: number;
  sunlight_hours: number;
  longest_night_ms: number;
  both_visible_windows: Array<{ start_ms: number; end_ms: number }>;
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
