/**
 * Pure display math for the scenes. No drawing and no data loading happens here, so every
 * function can be tested on its own.
 *
 * Units: angles in degrees, distances in km unless a name ends in `M` (metres), longitude
 * east-positive, azimuth from north clockwise, vectors in the Moon-fixed frame MOON_ME.
 */
import { discRadiusDeg, MOON_RADIUS_KM } from "../../engine/astro";
import { dot, magnitude, normalize, subtract } from "../../engine/math";
import type { Vector3 } from "../../engine/runtime-types";

const DEG = Math.PI / 180;

/** Apparent angular diameter of the Sun's or Earth's disc, degrees, from its distance in km. */
export function angularDiameterDeg(body: "sun" | "earth", distanceKm: number): number {
  return 2 * discRadiusDeg(body, distanceKm);
}

/**
 * Phase angle of the Earth, degrees: the angle at the Earth between the Sun and the observer.
 * 0 means the observer sees a full Earth, 180 a new Earth. All three inputs are Moon-centre
 * vectors in km (the observer's own position included).
 */
export function earthPhaseAngleDeg(sun: Vector3, earth: Vector3, eye: Vector3): number {
  const toSun = normalize(subtract(sun, earth));
  const toEye = normalize(subtract(eye, earth));
  return Math.acos(Math.min(1, Math.max(-1, dot(toSun, toEye)))) / DEG;
}

/** Sunlit fraction of a sphere's disc at a phase angle: (1 + cos phase) / 2, from 0 to 1. */
export function litFraction(phaseAngleDeg: number): number {
  return (1 + Math.cos(phaseAngleDeg * DEG)) / 2;
}

/** Angle between two directions seen from the Moon's centre, degrees. */
export function separationDeg(a: Vector3, b: Vector3): number {
  return Math.acos(Math.min(1, Math.max(-1, dot(normalize(a), normalize(b))))) / DEG;
}

/**
 * Elevation of the horizon of a smooth sphere seen from `heightM` above it, degrees (zero or
 * negative). Used only to draw a reference line where no terrain skyline exists.
 */
export function smoothHorizonDeg(heightM: number): number {
  const r = MOON_RADIUS_KM * 1000;
  return -Math.acos(r / (r + Math.max(0, heightM))) / DEG;
}

export type CoordinateCheck = { ok: true; lat: number; lon: number } | { ok: false; message: string };

/**
 * Check a typed latitude and longitude against the service region of the manifest.
 * Returns the numbers, or one sentence saying exactly what is wrong and what is accepted.
 */
export function validateCoordinates(latText: string, lonText: string, region: { lat_min: number; lat_max: number }): CoordinateCheck {
  const number = /^[+-]?(\d+\.?\d*|\.\d+)$/;
  const south = `${Math.abs(region.lat_max)}° S (${region.lat_max}) to ${Math.abs(region.lat_min)}° S (${region.lat_min})`;
  if (latText.trim() === "" || lonText.trim() === "") return { ok: false, message: "Enter both a latitude and a longitude, in degrees." };
  if (!number.test(latText.trim())) return { ok: false, message: `Latitude “${latText.trim()}” is not a number. Use degrees, for example -89.45.` };
  if (!number.test(lonText.trim())) return { ok: false, message: `Longitude “${lonText.trim()}” is not a number. Use degrees east, for example -137.16.` };
  const lat = Number(latText);
  const lon = Number(lonText);
  if (lat < -90 || lat > 90) return { ok: false, message: `Latitude ${lat}° does not exist. Latitudes run from -90 to 90; this app covers ${south}.` };
  if (lat < region.lat_min || lat > region.lat_max) return { ok: false, message: `Latitude ${lat}° is outside the south polar region. This app covers ${south}.` };
  if (lon < -180 || lon > 180) return { ok: false, message: `Longitude ${lon}° is out of range. Use -180 to 180, east positive (west is negative).` };
  return { ok: true, lat, lon };
}

/**
 * South polar stereographic projection on a sphere, true scale at the pole, longitude 0 up.
 * Returns map metres: x toward longitude 90 E, y toward longitude 0. This is the projection of
 * the LOLA polar maps; the radius comes from the hillshade's sidecar.
 */
export function polarProject(lat: number, lon: number, radiusM: number): { x: number; y: number } {
  const rho = 2 * radiusM * Math.tan(((90 + lat) / 2) * DEG);
  return { x: rho * Math.sin(lon * DEG), y: rho * Math.cos(lon * DEG) };
}

/** Inverse of `polarProject`: map metres to latitude and longitude in degrees. */
export function polarUnproject(x: number, y: number, radiusM: number): { lat: number; lon: number } {
  const rho = Math.hypot(x, y);
  return { lat: -90 + (2 * Math.atan(rho / (2 * radiusM))) / DEG, lon: rho === 0 ? 0 : Math.atan2(x, y) / DEG };
}

/**
 * Place a distance on a logarithmic axis: `minKm` maps to `r0`, `maxKm` to `r1`, and equal
 * ratios of distance map to equal steps.
 */
export function logRadius(distanceKm: number, minKm: number, maxKm: number, r0: number, r1: number): number {
  return r0 + ((Math.log10(distanceKm) - Math.log10(minKm)) / (Math.log10(maxKm) - Math.log10(minKm))) * (r1 - r0);
}

/**
 * Turn a MOON_ME vector into the axes three.js uses for the globe (its sphere has the north
 * pole on +Y and the texture's longitude 0 on +X): (x, y, z) becomes (x, z, -y).
 */
export function meToThree(v: Vector3): [number, number, number] {
  return [v.x, v.z, -v.y];
}

/** Unit vector toward (azimuth, elevation) as (east, north, up). */
export function azElToEnu(azDeg: number, elDeg: number): [number, number, number] {
  const c = Math.cos(elDeg * DEG);
  return [c * Math.sin(azDeg * DEG), c * Math.cos(azDeg * DEG), Math.sin(elDeg * DEG)];
}

/** The Blue Marble file for the month of a UTC time, for example `earth/bmng_11.jpg`. */
export function earthMonthFile(timeMs: number): string {
  return `earth/bmng_${String(new Date(timeMs).getUTCMonth() + 1).padStart(2, "0")}.jpg`;
}

/** Difference `a - b` between two azimuths, brought into -180..180 degrees. */
export function azDelta(a: number, b: number): number {
  return ((((a - b + 180) % 360) + 360) % 360) - 180;
}

/** Length of a vector, km. Re-exported so scenes need one import for display math. */
export const lengthKm = magnitude;
