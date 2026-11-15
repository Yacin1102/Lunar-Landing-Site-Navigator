// Shared inputs for the audit tests. Nothing here computes an expected value: expected values
// come from SPICE (fixtures), JPL Horizons, the Python engine, or closed forms in the tests.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EphemerisLabel } from "../../runtime-types";
import type { Skyline } from "../../types";

/** Repository root, from web/ (where vitest runs). */
export const REPO = resolve(process.cwd(), "..");

/** Read a JSON file relative to the repository root. */
export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(REPO, path), "utf8")) as T;
}

/** The committed timetable, read straight from disk (little-endian Float32). */
export function loadTimetable(folder = "web/public/data"): { label: EphemerisLabel; values: Float32Array } {
  const label = readJson<EphemerisLabel>(`${folder}/ephem.json`);
  const buffer = readFileSync(resolve(REPO, folder, "ephem.bin"));
  const values = new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  return { label, values };
}

/** A skyline of constant height and error, for closed-form checks. */
export function flatSkyline(heightDeg: number, errDeg = 0, stepDeg = 0.1, elevM = 0, mastM = 0): Skyline {
  const n = Math.round(360 / stepDeg);
  return {
    version: 1, lat: -89, lon: 0, elev_m: elevM, mast_m: mastM, az_step_deg: stepDeg,
    skyline_deg: new Array(n).fill(heightDeg), skyline_err_deg: new Array(n).fill(errDeg),
    dem: ["TEST"], resolution_m: 1, max_reach_km: 1,
  };
}

/** Angle between two azimuths around the circle, degrees (359.99 and 0.01 are 0.02 apart). */
export function azDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/** A small seeded random generator (mulberry32), so property tests are repeatable. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
