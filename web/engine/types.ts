/** A curated south-polar landing site and its display metadata. */
export interface Site {
  id: string;
  name: string;
  lat: number;
  lon: number;
  category: string;
  mission?: string;
  date_utc?: string;
  country?: string;
  notes?: string;
  has_terrain: boolean;
  has_shade_grid: boolean;
}

/** The prepared-data manifest that describes files and service coverage. */
export interface Manifest {
  version: number;
  data_kind: "mock" | "real";
  build_date: string;
  service_region: { min_lat: number; max_lat: number; min_lon: number; max_lon: number };
  files: string[];
  sites: Array<{ id: string; has_terrain: boolean; has_shade_grid: boolean }>;
}

/** The ephemeris label describing rows in the Float32 timetable. */
export interface EphemerisLabel {
  version: number;
  t0_ms: number;
  step_s: number;
  count: number;
  columns: ["sun_x", "sun_y", "sun_z", "earth_x", "earth_y", "earth_z"];
  units: "km";
  frame: "MOON_ME";
  origin: "MOON";
  aberration: string;
}

/** A skyline record for one observer point. */
export interface Skyline {
  version: number;
  lat: number;
  lon: number;
  elev_m: number;
  mast_m: number;
  az_step_deg: number;
  skyline_deg: number[];
  skyline_err_deg: number[];
  dem: string;
  resolution_m: number;
  max_reach_km: number;
}

/** A terrain patch label and its relative-height samples. */
export interface TerrainPatch {
  label: {
    version: number;
    lat: number;
    lon: number;
    elev_m: number;
    size_m: number;
    n: number;
    spacing_m: number;
    dem: string;
    resolution_m: number;
  };
  values: Float32Array;
}

/** A shade-grid label and its binary skyline/normal samples. */
export interface ShadeGrid {
  label: {
    version: number;
    center_lat: number;
    center_lon: number;
    size_m: number;
    n: number;
    spacing_m: number;
    az_step_deg: number;
    n_az: number;
    skyline_scale: number;
    mast_m: number;
    dem: string;
    resolution_m: number;
  };
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

/** Return the selected data folder, allowing deployment to switch real data on. */
export function getDataFolder(): string {
  return (import.meta.env.VITE_DATA_FOLDER as string | undefined) ?? "/data-mock";
}
