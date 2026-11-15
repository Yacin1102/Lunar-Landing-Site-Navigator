// Audit: the event search on the real skylines. The search is proven to skip no crossing if the
// margin it follows changes no faster than its rate bound. These tests check that bound against
// the timetable (how fast the Sun and the Earth really move) and against the margin itself on all
// 10 sites, and compare the search with dense scans. Expected values come from the committed
// timetable and skylines, not from the search.
import { describe, expect, it } from "vitest";
import { directionFromBody, interpolateBody } from "../../astro";
import {
  ANGULAR_SPEED_BOUND_DEG_PER_H,
  bodyCrossings,
  marginFunction,
  marginRateBoundDegPerMs,
  MAX_ABS_ELEVATION_DEG,
  RADIUS_RATE_BOUND_DEG_PER_H,
} from "../../events";
import { discRadiusDeg } from "../../astro";
import type { Skyline } from "../../types";
import { loadTimetable, readJson } from "./helpers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const { label, values } = loadTimetable();
const sites = readJson<{ sites: Array<{ id: string; lat: number; lon: number }> }>("web/public/data/sites.json").sites;
const skylines = new Map(sites.map((s) => [s.id, readJson<Skyline>(`web/public/data/skylines/${s.id}.json`)]));

/** Angle between two directions given as azimuth and elevation, degrees (independent of the engine). */
function angleBetween(a: { az_deg: number; el_deg: number }, b: { az_deg: number; el_deg: number }): number {
  const r = Math.PI / 180;
  const c = Math.sin(a.el_deg * r) * Math.sin(b.el_deg * r) + Math.cos(a.el_deg * r) * Math.cos(b.el_deg * r) * Math.cos((b.az_deg - a.az_deg) * r);
  return Math.acos(Math.min(1, c)) / r;
}

describe("the rate bound against the real sky", () => {
  it("is above the fastest motion of the Sun and the Earth over the whole timetable", () => {
    const step = 10 * 60_000;
    const end = label.t0_ms + (label.count - 1) * label.step_s * 1000;
    const lines: string[] = [];
    for (const [body, offset] of [["sun", 0], ["earth", 3]] as const) {
      let speed = 0;
      let radiusRate = 0;
      let highest = 0;
      for (const [lat, lon] of [[-80, 0], [-80, 180], [-89.99, 90]]) {
        let prev = directionFromBody(interpolateBody(values, label, label.t0_ms, offset), lat, lon, 0, 0);
        for (let t = label.t0_ms + step; t <= end; t += step) {
          const d = directionFromBody(interpolateBody(values, label, t, offset), lat, lon, 0, 0);
          speed = Math.max(speed, angleBetween(prev, d) / (step / HOUR));
          radiusRate = Math.max(radiusRate, Math.abs(discRadiusDeg(body, d.distance_km) - discRadiusDeg(body, prev.distance_km)) / (step / HOUR));
          highest = Math.max(highest, Math.abs(d.el_deg));
          prev = d;
        }
      }
      expect(speed * 1.1, body).toBeLessThan(ANGULAR_SPEED_BOUND_DEG_PER_H[body]);
      expect(radiusRate * 2, body).toBeLessThan(RADIUS_RATE_BOUND_DEG_PER_H);
      expect(highest, body).toBeLessThan(MAX_ABS_ELEVATION_DEG);
      lines.push(`${body}: fastest ${speed.toFixed(4)} deg/h (bound ${ANGULAR_SPEED_BOUND_DEG_PER_H[body]}), radius ${radiusRate.toExponential(2)} deg/h (bound ${RADIUS_RATE_BOUND_DEG_PER_H}), highest |el| ${highest.toFixed(2)} (bound ${MAX_ABS_ELEVATION_DEG})`);
    }
    console.log(`2026-2040, 80S to the pole, every 10 minutes:\n  ${lines.join("\n  ")}`);
  }, 120_000);

  it("is never exceeded by the margin on the 10 real skylines, around every kind of crossing", () => {
    // Around up to 4 crossings per site, body and skyline, sample the margin every 2 s for an
    // hour. A jump (what the old clearance did at wedge boundaries) would exceed the bound.
    let samples = 0;
    let worstRatio = 0;
    const start = label.t0_ms + 30 * DAY;
    for (const site of sites) {
      const sky = skylines.get(site.id)!;
      for (const body of ["sun", "earth"] as const) {
        const bound = marginRateBoundDegPerMs(body);
        for (const shift of [1, 0, -1] as const) {
          const f = marginFunction(values, label, sky, site, body, shift);
          const c = bodyCrossings(values, label, sky, site, body, shift, start, start + 120 * DAY);
          const centres = [...c.rise_ms, ...c.set_ms].slice(0, 4);
          if (centres.length === 0) centres.push(start + DAY);
          for (const centre of centres) {
            let prev = f(centre - HOUR / 2);
            for (let t = centre - HOUR / 2 + 2000; t <= centre + HOUR / 2; t += 2000) {
              const v = f(t);
              worstRatio = Math.max(worstRatio, Math.abs(v - prev) / (2000 * bound));
              prev = v;
              samples += 1;
            }
          }
        }
      }
    }
    console.log(`${samples} margin samples, 2 s apart: fastest change is ${(100 * worstRatio).toFixed(1)} % of the bound`);
    expect(worstRatio).toBeLessThan(1);
  }, 300_000);
});

describe("the search against dense scans", () => {
  /** Every sign change of f between samples `step` apart: the interval it lies in. */
  function denseChanges(f: (t: number) => number, a: number, b: number, step: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let prevT = a;
    let prev = f(a) > 0;
    for (let t = a + step; t <= b; t += step) {
      const now = f(t) > 0;
      if (now !== prev) out.push([prevT, t]);
      prev = now;
      prevT = t;
    }
    return out;
  }

  it("finds every crossing a 30 s scan finds over a year, where the old 10-minute scan missed many", () => {
    // Before the fix, over these same 365 days (starting 30 days into the table), the old search
    // found 51 of the 61 nominal sunrises and sunsets at the Malapert massif, and 40 of the 58
    // certain-sunlight crossings at the de Gerlache rim (docs/WEB_AUDIT.md, finding 14).
    const start = label.t0_ms + 30 * DAY;
    const end = start + 365 * DAY;
    for (const [id, shift] of [["malapert_massif", 0], ["de_gerlache_rim", 1]] as const) {
      const site = sites.find((s) => s.id === id)!;
      const sky = skylines.get(id)!;
      const f = marginFunction(values, label, sky, site, "sun", shift);
      const c = bodyCrossings(values, label, sky, site, "sun", shift, start, end);
      const found = [...c.rise_ms, ...c.set_ms].sort((p, q) => p - q);
      const dense = denseChanges(f, start, end, 30_000);
      for (const [a, b] of dense) {
        expect(found.some((t) => t >= a - 1 && t <= b + 1), `${id}: dense crossing between ${new Date(a).toISOString()} and ${new Date(b).toISOString()} not found`).toBe(true);
      }
      expect(found.length).toBeGreaterThanOrEqual(dense.length);
      console.log(`${id}, sun, shift ${shift}: search ${found.length} crossings, 30 s scan ${dense.length}`);
    }
  }, 300_000);
});
