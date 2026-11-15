import type { Direction, EphemerisLabel, Vector3 } from "./runtime-types";
import { degToRad, dot, magnitude, radToDeg } from "./math";

/** The spherical radius required by the shared Moon height reference, km. */
export const MOON_RADIUS_KM = 1737.4;
/** The Sun's radius (IAU, `pck00011.tpc`), km; sets the apparent disc size. */
export const SUN_RADIUS_KM = 695700;
/**
 * The Earth's polar radius (`pck00011.tpc`), km. From the south pole the upper edge of the Earth's
 * disc is near one of the Earth's poles, so the polar radius is the closer and the cautious choice:
 * the equatorial 6378.137 km would put the edge up to 0.0032 degrees too high (docs/ACCURACY.md).
 * The fixtures were made with this value.
 */
export const EARTH_RADIUS_KM = 6356.7519;
/** Points closer to the pole than this latitude are moved to it, so that north is defined. */
export const POLE_LAT_LIMIT_DEG = -89.99999;

/** Convert latitude/longitude (degrees) and height above the 1737.4 km sphere (metres) to a Moon-fixed position in km. */
export function sitePosition(latDeg: number, lonDeg: number, heightM: number): Vector3 {
  const lat = degToRad(latDeg);
  const lon = degToRad(lonDeg);
  const radius = MOON_RADIUS_KM + heightM / 1000;
  return {
    x: radius * Math.cos(lat) * Math.cos(lon),
    y: radius * Math.cos(lat) * Math.sin(lon),
    z: radius * Math.sin(lat),
  };
}

/** Build the east, north, and up unit vectors at a lunar site (formulas of docs/WEB_HANDOFF.md). */
export function localBasis(latDeg: number, lonDeg: number): { east: Vector3; north: Vector3; up: Vector3 } {
  const lat = degToRad(latDeg);
  const lon = degToRad(lonDeg);
  return {
    east: { x: -Math.sin(lon), y: Math.cos(lon), z: 0 },
    north: { x: -Math.sin(lat) * Math.cos(lon), y: -Math.sin(lat) * Math.sin(lon), z: Math.cos(lat) },
    up: { x: Math.cos(lat) * Math.cos(lon), y: Math.cos(lat) * Math.sin(lon), z: Math.sin(lat) },
  };
}

/** First and last time the timetable covers, UTC milliseconds. */
export function timetableSpan(label: Pick<EphemerisLabel, "t0_ms" | "step_s" | "count">): { startMs: number; endMs: number } {
  return { startMs: label.t0_ms, endMs: label.t0_ms + (label.count - 1) * label.step_s * 1000 };
}

/**
 * Interpolate one body's Moon-centre vector (km) from the timetable at any UTC time.
 *
 * The cubic through four rows of docs/WEB_HANDOFF.md (4-point Lagrange): for a time between rows
 * `i` and `i+1`, rows `i-1 .. i+2`, with `u` the position among them (0 at row `i-1`). In the
 * first and last interval the four nearest rows are used. It is the same as `interpolate_rows` in
 * python/lunar_engine/ephemeris.py. A time outside the table is refused: extrapolating would put
 * the Sun in the wrong place without warning.
 */
export function interpolateBody(
  values: Float32Array,
  label: Pick<EphemerisLabel, "t0_ms" | "step_s" | "count">,
  timeMs: number,
  offset: 0 | 3,
): Vector3 {
  const position = (timeMs - label.t0_ms) / (label.step_s * 1000);
  if (!(position >= 0 && position <= label.count - 1)) {
    throw new RangeError(`Time ${new Date(timeMs).toISOString()} is outside the timetable`);
  }
  if (label.count < 4) throw new RangeError("The timetable needs at least four rows");
  const first = Math.min(Math.max(Math.floor(position) - 1, 0), label.count - 4);
  const u = position - first;
  const w = [
    -(u - 1) * (u - 2) * (u - 3) / 6,
    u * (u - 2) * (u - 3) / 2,
    -u * (u - 1) * (u - 3) / 2,
    u * (u - 1) * (u - 2) / 6,
  ];
  const result = { x: 0, y: 0, z: 0 };
  for (let k = 0; k < 4; k += 1) {
    const row = (first + k) * 6 + offset;
    result.x += w[k] * values[row];
    result.y += w[k] * values[row + 1];
    result.z += w[k] * values[row + 2];
  }
  return result;
}

/**
 * Convert a Moon-centre body vector (km) into azimuth/elevation at a site.
 *
 * The eye is at `R + elev_m + mast_m`; the body's direction is the body vector minus the eye's
 * position (parallax: up to 0.26 degrees for the Earth), read in the site's east/north/up frame.
 * Azimuth is from north, clockwise, in [0, 360); elevation is above the level plane.
 */
export function directionFromBody(
  bodyPosition: Vector3,
  latDeg: number,
  lonDeg: number,
  elevM: number,
  mastM = 0,
): Direction {
  const lat = Math.max(latDeg, POLE_LAT_LIMIT_DEG);
  const observer = sitePosition(lat, lonDeg, elevM + mastM);
  const relative = {
    x: bodyPosition.x - observer.x,
    y: bodyPosition.y - observer.y,
    z: bodyPosition.z - observer.z,
  };
  const basis = localBasis(lat, lonDeg);
  const east = dot(relative, basis.east);
  const north = dot(relative, basis.north);
  const up = dot(relative, basis.up);
  // atan2 rather than asin(up / |d|): the same angle, and no clamping needed near +-90 degrees.
  let az = radToDeg(Math.atan2(east, north));
  if (az < 0) az += 360;
  if (az >= 360) az -= 360;
  return { az_deg: az, el_deg: radToDeg(Math.atan2(up, Math.hypot(east, north))), distance_km: magnitude(relative) };
}

/** Sun and Earth directions at a site and UTC time, from the interpolated timetable. */
export function directionsAt(
  values: Float32Array,
  label: EphemerisLabel,
  timeMs: number,
  latDeg: number,
  lonDeg: number,
  elevM: number,
  mastM = 0,
): { sun: Direction; earth: Direction } {
  return {
    sun: directionFromBody(interpolateBody(values, label, timeMs, 0), latDeg, lonDeg, elevM, mastM),
    earth: directionFromBody(interpolateBody(values, label, timeMs, 3), latDeg, lonDeg, elevM, mastM),
  };
}

/** Apparent angular radius of a body's disc, degrees: `asin(radius / distance from the eye)`. */
export function discRadiusDeg(body: "sun" | "earth", distanceKm: number): number {
  const radiusKm = body === "sun" ? SUN_RADIUS_KM : EARTH_RADIUS_KM;
  return radToDeg(Math.asin(Math.min(1, radiusKm / distanceKm)));
}

/** Index of the skyline entry whose wedge contains an azimuth: `round(az / step) % n`, wrapping at north. */
export function skylineIndex(azStepDeg: number, entries: number, azDeg: number): number {
  const wrapped = ((azDeg % 360) + 360) % 360;
  return Math.round(wrapped / azStepDeg) % entries;
}

/**
 * Skyline elevation at an azimuth, degrees. The skyline is a step function: entry `k` holds for
 * every azimuth within half a step of `k * step`. It is never interpolated, because interpolation
 * can cut the corner off a peak and call a blocked Sun clear.
 */
export function skylineAt(skyline: number[], azStepDeg: number, azDeg: number): number {
  return skyline[skylineIndex(azStepDeg, skyline.length, azDeg)];
}
