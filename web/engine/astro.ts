import type { Direction, EphemerisLabel, Vector3 } from "./runtime-types";
import { clamp, degToRad, dot, lerp, magnitude, radToDeg } from "./math";

/** The spherical radius required by the shared Moon height reference. */
export const MOON_RADIUS_KM = 1737.4;
/** The physical radius of the Sun used for its apparent disc size. */
export const SUN_RADIUS_KM = 695700;
/** The physical radius of the Earth used for its apparent disc size. */
export const EARTH_RADIUS_KM = 6378.137;

/** Convert latitude/longitude and elevation to a Moon-fixed observer position. */
export function sitePosition(latDeg: number, lonDeg: number, elevM: number): Vector3 {
  const lat = degToRad(latDeg);
  const lon = degToRad(lonDeg);
  const radius = MOON_RADIUS_KM + elevM / 1000;
  return {
    x: radius * Math.cos(lat) * Math.cos(lon),
    y: radius * Math.cos(lat) * Math.sin(lon),
    z: radius * Math.sin(lat),
  };
}

/** Build the east, north, and up unit vectors at a lunar site. */
export function localBasis(latDeg: number, lonDeg: number): { east: Vector3; north: Vector3; up: Vector3 } {
  const lat = degToRad(latDeg);
  const lon = degToRad(lonDeg);
  return {
    east: { x: -Math.sin(lon), y: Math.cos(lon), z: 0 },
    north: { x: -Math.sin(lat) * Math.cos(lon), y: -Math.sin(lat) * Math.sin(lon), z: Math.cos(lat) },
    up: { x: Math.cos(lat) * Math.cos(lon), y: Math.cos(lat) * Math.sin(lon), z: Math.sin(lat) },
  };
}

/** Interpolate a timetable body vector with cubic Catmull-Rom samples. */
export function interpolateBody(
  values: Float32Array,
  label: Pick<EphemerisLabel, "t0_ms" | "step_s" | "count">,
  timeMs: number,
  offset: 0 | 3,
): Vector3 {
  const position = (timeMs - label.t0_ms) / (label.step_s * 1000);
  const i = clamp(Math.floor(position), 0, label.count - 2);
  const fraction = clamp(position - i, 0, 1);
  const sample = (index: number): Vector3 => {
    const row = clamp(index, 0, label.count - 1) * 6 + offset;
    return { x: values[row], y: values[row + 1], z: values[row + 2] };
  };
  const p0 = sample(i - 1);
  const p1 = sample(i);
  const p2 = sample(i + 1);
  const p3 = sample(i + 2);
  const f2 = fraction * fraction;
  const f3 = f2 * fraction;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * fraction + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * f2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * f3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * fraction + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * f2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * f3),
    z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * fraction + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * f2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * f3),
  };
}

/** Convert a Moon-fixed body vector into azimuth/elevation at a site. */
export function directionFromBody(
  bodyPosition: Vector3,
  latDeg: number,
  lonDeg: number,
  elevM: number,
  mastM = 0,
): Direction {
  const observer = sitePosition(latDeg, lonDeg, elevM + mastM);
  const relative = {
    x: bodyPosition.x - observer.x,
    y: bodyPosition.y - observer.y,
    z: bodyPosition.z - observer.z,
  };
  const basis = localBasis(latDeg, lonDeg);
  const east = dot(relative, basis.east);
  const north = dot(relative, basis.north);
  const up = dot(relative, basis.up);
  const horizontal = Math.hypot(east, north);
  let az = radToDeg(Math.atan2(east, north));
  if (az < 0) az += 360;
  return { az_deg: az, el_deg: radToDeg(Math.atan2(up, horizontal)), distance_km: magnitude(relative) };
}

/** Calculate Sun and Earth directions from the interpolated prepared timetable. */
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

/** Return the apparent angular radius of a body disc in degrees. */
export function discRadiusDeg(body: "sun" | "earth", distanceKm: number): number {
  const radiusKm = body === "sun" ? SUN_RADIUS_KM : EARTH_RADIUS_KM;
  return radToDeg(Math.asin(clamp(radiusKm / distanceKm, 0, 1)));
}

/** Interpolate a skyline entry at any azimuth, including the circular seam. */
export function skylineAt(skyline: number[], azStepDeg: number, azDeg: number): number {
  const wrapped = ((azDeg % 360) + 360) % 360;
  const position = wrapped / azStepDeg;
  const left = Math.floor(position);
  const fraction = position - left;
  const a = skyline[left % skyline.length];
  const b = skyline[(left + 1) % skyline.length];
  return a + (b - a) * fraction;
}
