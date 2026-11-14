// GENERATED FILE - do not edit by hand.
// Source: docs/schemas/*.schema.json   Generator: python/scripts/gen_types.py
//
// Data contracts between the Python engine and the web app
// (spec/ENGINE_GUIDE.md, explained in docs/WEB_HANDOFF.md).
//
// Shared rules: angles in degrees; azimuth from north, clockwise; longitude
// east positive, -180 to 180; heights and distances in metres; Sun/Earth
// positions in km; times in UTC milliseconds since 1970; frame MOON_ME;
// height reference sphere of radius 1737.4 km.

/**
 * Label of ephem.bin, the Sun/Earth timetable (Contract 1). ephem.bin holds `count` rows
 * of six little-endian Float32 values in the order of `columns`. Row i is at time t0_ms +
 * i * step_s * 1000.
 */
export interface EphemLabel {
  /** Format version of this file. Increased on any format change. */
  version: 1;
  /** UTC time of row 0, milliseconds since 1970-01-01: 16 Nov 2026 00:00 UTC. */
  t0_ms: 1794787200000;
  /** Time between rows, seconds. Read it from here; do not assume a value. */
  step_s: number;
  /** Number of rows in ephem.bin. */
  count: number;
  /**
   * The six values of each row, in order: the vector from the centre of the Moon to the Sun,
   * then to the Earth.
   */
  columns: ["sun_x", "sun_y", "sun_z", "earth_x", "earth_y", "earth_z"];
  /** Unit of every value. */
  units: "km";
  /** Moon-fixed frame of the vectors. */
  frame: "MOON_ME";
  /** The vectors start at the centre of the Moon. */
  origin: "MOON";
  /**
   * SPICE correction used; positions are apparent (light time and stellar aberration
   * corrected).
   */
  aberration: string;
}

/** One curated south polar site. */
export interface Site {
  /**
   * Unique, stable identifier. Used in file names: skylines/{id}.json, terrain/{id}.bin,
   * shade/{id}.json.
   */
  id: string;
  /** Display name. */
  name: string;
  /** Latitude, degrees, -90 to 90. */
  lat: number;
  /** Longitude, degrees, east positive, -180 to 180. */
  lon: number;
  /**
   * Short lowercase group name for the menu. Group by whatever values appear; do not
   * hard-code the set.
   */
  category: string;
  /** Info-card text: mission name. */
  mission?: string;
  /** Info-card text: a date in ISO 8601. */
  date_utc?: string;
  /** Info-card text: country or agency. */
  country?: string;
  /** Info-card text: free notes. */
  notes?: string;
  /** True only if terrain/{id}.bin and terrain/{id}.json exist. */
  has_terrain: boolean;
  /** True only if the three shade/{id}* files exist. */
  has_shade_grid: boolean;
}

/** sites.json, the curated site list (Contract 2). The only place site coordinates exist. */
export interface SiteList {
  /** Format version of this file. Increased on any format change. */
  version: 1;
  /** The 10 curated sites. */
  sites: Site[];
}

/**
 * A skyline (Contract 3): for each azimuth, the highest elevation angle at which terrain
 * appears from the eye of the observer. Used for skylines/{id}.json and for the
 * /api/skyline response. Entry k of both arrays belongs to azimuth k * az_step_deg and
 * covers the wedge of azimuths within half a step either side of it.
 */
export interface Skyline {
  /** Format version of this file. Increased on any format change. */
  version: 1;
  /** Latitude of the point actually used (after any rounding), degrees. */
  lat: number;
  /** Longitude of the point actually used (after any rounding), degrees, east positive. */
  lon: number;
  /** Ground height at the point, metres above the 1737.4 km sphere. */
  elev_m: number;
  /** Eye height above the ground, metres. */
  mast_m: number;
  /** Spacing between azimuths, degrees. 360 / az_step_deg is a whole number. */
  az_step_deg: number;
  /**
   * 360 / az_step_deg elevation angles, degrees above the local level plane (negative =
   * below). Entry k is the maximum over its whole wedge.
   */
  skyline_deg: number[];
  /**
   * 360 / az_step_deg uncertainty bounds, degrees. The true skyline at entry k lies within
   * skyline_deg[k] +/- skyline_err_deg[k].
   */
  skyline_err_deg: number[];
  /** Names of the elevation map(s) used. Show this with every result. */
  dem: string[];
  /**
   * Pixel size of the finest elevation map used near the point, metres. Show this with every
   * result.
   */
  resolution_m: number;
  /** Farthest distance any azimuth had to search, km. */
  max_reach_km: number;
}

/**
 * Label of terrain/{id}.bin, the terrain patch for the 3D view (Contract 4). The .bin
 * holds n * n little-endian Float32 heights, rows north to south, columns west to east.
 * Sample (row i, column j) is at east = (j - (n-1)/2) * spacing_m, north = ((n-1)/2 - i) *
 * spacing_m in the level plane of the site; its value is the ground height above that
 * plane, metres, measured along the vertical of the site. Centre value is 0. Display only.
 */
export interface TerrainLabel {
  /** Format version of this file. Increased on any format change. */
  version: 1;
  /** Latitude, degrees, -90 to 90. */
  lat: number;
  /** Longitude, degrees, east positive, -180 to 180. */
  lon: number;
  /** Ground height at the site (the patch centre), metres above the 1737.4 km sphere. */
  elev_m: number;
  /** Side length of the patch, metres: (n - 1) * spacing_m. */
  size_m: number;
  /** Samples per side. Odd, so that the site is the centre sample. */
  n: number;
  /** Distance between neighbouring samples, metres. */
  spacing_m: number;
  /** Names of the elevation map(s) used. Show this with every result. */
  dem: string[];
  /**
   * Pixel size of the finest elevation map used near the point, metres. Show this with every
   * result.
   */
  resolution_m: number;
}

/**
 * Label of the shade grid for the 3D view (Contract 5): shade/{id}_skyline.bin and
 * shade/{id}_normal.bin. Cells are laid out like the terrain patch (rows north to south,
 * columns west to east). _skyline.bin holds n * n * n_az little-endian Int16 values, the
 * azimuths of one cell together, starting at north and going clockwise; degrees = stored
 * value * skyline_scale. _normal.bin holds n * n * 3 little-endian Float32 values: the
 * unit surface normal of each cell as (east, north, up). All azimuths, elevations and
 * normals are in the east/north/up frame of the patch centre, not of the individual cell.
 */
export interface ShadeLabel {
  /** Format version of this file. Increased on any format change. */
  version: 1;
  /** Latitude of the patch centre (the site), degrees. */
  center_lat: number;
  /** Longitude of the patch centre (the site), degrees, east positive. */
  center_lon: number;
  /** Side length of the grid, metres: (n - 1) * spacing_m. */
  size_m: number;
  /** Cells per side. Odd. */
  n: number;
  /** Distance between neighbouring cells, metres. */
  spacing_m: number;
  /** Spacing between azimuths, degrees. 360 / az_step_deg = n_az. */
  az_step_deg: number;
  /** Number of azimuths stored per cell. */
  n_az: number;
  /** Multiply a stored Int16 by this to get degrees. */
  skyline_scale: number;
  /** Eye height above the ground used for every cell, metres. */
  mast_m: number;
  /** Names of the elevation map(s) used. Show this with every result. */
  dem: string[];
  /**
   * Pixel size of the finest elevation map used near the point, metres. Show this with every
   * result.
   */
  resolution_m: number;
}

/** The part of the Moon the app covers: all longitudes between two latitudes. */
export interface ServiceRegion {
  /** Southern limit, degrees (-90). */
  lat_min: number;
  /**
   * Northern limit, degrees. Always south of the equator: the app covers the south polar
   * region only. Points north of this are refused.
   */
  lat_max: number;
}

/** One file in the data folder. */
export interface ManifestFile {
  /** Path relative to the data folder, forward slashes. */
  path: string;
  /** Which contract the file belongs to. */
  contract: "ephem" | "sites" | "skyline" | "terrain" | "shade";
  /** Format version of that contract. */
  version: number;
  /** File size, bytes. */
  bytes: number;
}

/** Which optional files a site has. */
export interface ManifestSite {
  /** Site id, as in sites.json. */
  id: string;
  /** Terrain patch files exist. */
  has_terrain: boolean;
  /** Shade grid files exist. */
  has_shade_grid: boolean;
}

/** manifest.json (spec section 12): what the data folder contains. Written last. */
export interface Manifest {
  /** Format version of this file. Increased on any format change. */
  version: 1;
  /**
   * mock = invented landscape for development; never show results from it as real verdicts.
   * real = built from NASA data.
   */
  data_kind: "mock" | "real";
  /** When the folder was built, UTC milliseconds since 1970-01-01. */
  built_ms: number;
  /** The part of the Moon the app covers: all longitudes between two latitudes. */
  service_region: ServiceRegion;
  /** Every file produced, except the manifest itself. */
  files: ManifestFile[];
  /** One entry per site in sites.json. */
  sites: ManifestSite[];
}

/** One test case. */
export interface AltAzCase {
  /** What the case is meant to expose. */
  name?: string;
  /** Latitude, degrees, -90 to 90. */
  lat: number;
  /** Longitude, degrees, east positive, -180 to 180. */
  lon: number;
  /** Ground height, metres above the 1737.4 km sphere. */
  elev_m: number;
  /** Eye height above the ground, metres. */
  mast_m: number;
  /** UTC time, milliseconds since 1970-01-01. */
  t_ms: number;
  /** Elevation of the centre of the Sun, degrees above the local level plane. */
  sunEl: number;
  /** Azimuth of the centre of the Sun, degrees from north, clockwise, 0 to 360. */
  sunAz: number;
  /** Elevation of the centre of the Earth, degrees. */
  earthEl: number;
  /** Azimuth of the centre of the Earth, degrees from north, clockwise, 0 to 360. */
  earthAz: number;
}

/**
 * altaz.json, known-correct Sun and Earth directions for the TypeScript tests (Contract
 * 6). Computed directly with SPICE, independently of the timetable. Pass mark: 0.01
 * degrees.
 */
export interface AltAzFixture {
  /** Format version of this file. Increased on any format change. */
  version: 1;
  /** The test cases. */
  cases: AltAzCase[];
}

/** One test case: every event between start_ms and end_ms. */
export interface EventsCase {
  /** What the case is meant to expose. */
  name?: string;
  /** Latitude, degrees, -90 to 90. */
  lat: number;
  /** Longitude, degrees, east positive, -180 to 180. */
  lon: number;
  /** Start of the window, UTC milliseconds since 1970-01-01. */
  start_ms: number;
  /** End of the window, UTC milliseconds since 1970-01-01. */
  end_ms: number;
  /** Sunrises. UTC milliseconds since 1970-01-01, in time order. */
  sunrise_ms: number[];
  /** Sunsets. UTC milliseconds since 1970-01-01, in time order. */
  sunset_ms: number[];
  /** Earthrises. UTC milliseconds since 1970-01-01, in time order. */
  earthrise_ms: number[];
  /** Earthsets. UTC milliseconds since 1970-01-01, in time order. */
  earthset_ms: number[];
}

/**
 * events.json, known-correct rise and set times for the TypeScript tests (Contract 6), for
 * a smooth Moon with no terrain and the eye at ground level. Rise and set are when the
 * upper edge of the disc crosses the level horizon. Pass mark: 60 seconds.
 */
export interface EventsFixture {
  /** Format version of this file. Increased on any format change. */
  version: 1;
  /** The test cases. */
  cases: EventsCase[];
}

/** Response of GET /api/health (Contract 7). */
export interface ApiHealth {
  /** Format version of this file. Increased on any format change. */
  version: 1;
  /** The server is running. */
  ok: true;
  /**
   * True if the server reads the real NASA elevation maps. False means synthetic terrain for
   * development: do not show its skylines as real verdicts.
   */
  real_terrain: boolean;
  /** The part of the Moon the app covers: all longitudes between two latitudes. */
  service_region: ServiceRegion;
  /** az_step_deg used when the request gives none, degrees. */
  az_step_deg_default: number;
  /** Accepted az_step_deg values, degrees. */
  az_step_deg_allowed: number[];
  /** mast_m used when the request gives none, metres. */
  mast_m_default: number;
  /** Largest accepted mast_m, metres. */
  mast_m_max: number;
}

/** What was wrong. */
export interface ApiErrorDetail {
  /** Machine-readable reason. */
  code: "missing_parameter" | "invalid_value" | "out_of_region" | "not_found" | "internal";
  /** The request parameter at fault, if one is. */
  param?: string;
  /** Explanation for a person. */
  message: string;
}

/**
 * Body of every refused request (HTTP status 400 for a bad or missing value, 422 for a
 * point outside the service region).
 */
export interface ApiError {
  /** Format version of this file. Increased on any format change. */
  version: 1;
  /** Always false. */
  ok: false;
  /** What was wrong. */
  error: ApiErrorDetail;
}

/** Radius of the height reference sphere, metres. */
export const MOON_RADIUS_M = 1737400;

/** Order of the six Float32 values in each row of ephem.bin. */
export const EPHEM_COLUMNS = ["sun_x", "sun_y", "sun_z", "earth_x", "earth_y", "earth_z"] as const;

/** Bytes per row of ephem.bin (six little-endian Float32). */
export const EPHEM_ROW_BYTES = 24;
