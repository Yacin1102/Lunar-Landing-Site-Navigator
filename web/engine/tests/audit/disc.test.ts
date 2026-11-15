// Audit: how much of a disc clears the skyline, and the lit / blocked / uncertain verdict.
// Expected values: the circle-segment formula, a brute-force area count written here, and the
// approved rule (docs/PROGRESS.md, decided 2026-11-15).
import { describe, expect, it } from "vitest";
import { discRadiusDeg, EARTH_RADIUS_KM, skylineAt, SUN_RADIUS_KM } from "../../astro";
import { classifyVisibility, discClearanceDeg, visibleDiscFraction } from "../../visibility";
import type { Skyline } from "../../types";
import { flatSkyline, readJson } from "./helpers";

const SUN_KM = 1.496e8;
const RHO = discRadiusDeg("sun", SUN_KM);

/** Exact fraction of a disc above a straight horizon at offset d (in radii) below the centre. */
function segmentFraction(d: number): number {
  if (d >= 1) return 1;
  if (d <= -1) return 0;
  return 1 - (Math.acos(d) - d * Math.sqrt(1 - d * d)) / Math.PI;
}

/** Brute force: count grid points of the disc above the step skyline (independent of the engine). */
function bruteForceFraction(azDeg: number, elDeg: number, rho: number, skyline: Skyline, grid = 1500): number {
  let inside = 0;
  let above = 0;
  const cosEl = Math.cos(elDeg * Math.PI / 180);
  for (let i = 0; i < grid; i += 1) {
    for (let j = 0; j < grid; j += 1) {
      const x = -rho + (i + 0.5) * 2 * rho / grid;
      const y = -rho + (j + 0.5) * 2 * rho / grid;
      if (x * x + y * y > rho * rho) continue;
      inside += 1;
      const az = azDeg + x / cosEl;
      if (elDeg + y > skylineAt(skyline.skyline_deg, skyline.az_step_deg, az)) above += 1;
    }
  }
  return above / inside;
}

describe("visible fraction of the disc", () => {
  it("matches the circle-segment formula on a flat skyline at several offsets", () => {
    const sky = flatSkyline(0);
    for (const d of [-1.2, -1, -0.9, -0.5, -0.1, 0, 0.3, 0.7, 0.9, 1, 1.3]) {
      const f = visibleDiscFraction({ az_deg: 123.4, el_deg: d * RHO, distance_km: SUN_KM }, "sun", sky);
      expect(f, `d=${d}`).toBeCloseTo(segmentFraction(d), 9);
    }
  });

  it("matches a brute-force count for a thin peak inside the disc, also across north", () => {
    const sky = flatSkyline(0, 0, 0.1);
    sky.skyline_deg[0] = 10; // a peak in the wedge from 359.95 to 0.05 degrees
    sky.skyline_deg[2] = 0.1; // a lower bump at 0.2 degrees
    for (const [az, el] of [[0.03, 0.05], [359.9, 0.2], [0.2, -0.05]]) {
      const engine = visibleDiscFraction({ az_deg: az, el_deg: el, distance_km: SUN_KM }, "sun", sky);
      const brute = bruteForceFraction(az, el, RHO, sky);
      expect(Math.abs(engine - brute), `az=${az} el=${el}`).toBeLessThan(2e-3);
    }
  });

  it("reads each wedge as a step: a peak one wedge wide is never smoothed away", () => {
    // Entries [0, 10, 0, ...] at 1 degree. At azimuth 0.6 (wedge of entry 1) the terrain is 10
    // degrees high, so a Sun at 8 degrees is hidden. Interpolating would have read 6 degrees.
    const sky = flatSkyline(0, 0, 1);
    sky.skyline_deg[1] = 10;
    expect(skylineAt(sky.skyline_deg, 1, 0.6)).toBe(10);
    expect(skylineAt(sky.skyline_deg, 1, 0.4)).toBe(0);
    const v = classifyVisibility({ az_deg: 1.0, el_deg: 8, distance_km: SUN_KM }, "sun", sky);
    expect(v.fraction).toBe(0);
    expect(v.status).toBe("blocked");
  });

  it("uses the radii of the fixtures: Sun 695,700 km, Earth 6356.7519 km (polar)", () => {
    expect(SUN_RADIUS_KM).toBe(695700);
    expect(EARTH_RADIUS_KM).toBe(6356.7519);
    const fixtureRadii = readJson<{ sun_radius_km: number; earth_radius_km: number }>("web/engine/tests/audit/fixtures/python_reference.json");
    expect(fixtureRadii.sun_radius_km).toBe(SUN_RADIUS_KM);
    expect(fixtureRadii.earth_radius_km).toBe(EARTH_RADIUS_KM);
    expect(discRadiusDeg("earth", 384400)).toBeCloseTo(Math.asin(6356.7519 / 384400) * 180 / Math.PI, 12);
  });

  it("has a clearance equal to centre + radius on a flat skyline at 0 (the events.json edge)", () => {
    const el = -0.1;
    expect(discClearanceDeg({ az_deg: 10, el_deg: el, distance_km: SUN_KM }, "sun", flatSkyline(0))).toBeCloseTo(el + RHO, 12);
  });
});

describe("lit, blocked or uncertain (approved rule)", () => {
  const sky = flatSkyline(0, 0.03);
  const at = (el: number) => classifyVisibility({ az_deg: 200, el_deg: el, distance_km: SUN_KM }, "sun", sky);

  it("is lit when some of the disc clears skyline + error", () => {
    const v = at(0.1);
    expect(v.status).toBe("visible");
    expect(v.fraction_low).toBeCloseTo(segmentFraction((0.1 - 0.03) / RHO), 9);
  });

  it("is blocked when none of the disc clears skyline - error", () => {
    const v = at(-RHO - 0.031);
    expect(v.status).toBe("blocked");
    expect(v.fraction_high).toBe(0);
  });

  it("is uncertain in between, with the fraction as a range", () => {
    const v = at(-RHO - 0.01);
    expect(v.status).toBe("uncertain");
    expect(v.fraction_low).toBe(0);
    expect(v.fraction_high).toBeGreaterThan(0);
    expect(v.fraction).toBe(0);
  });
});
