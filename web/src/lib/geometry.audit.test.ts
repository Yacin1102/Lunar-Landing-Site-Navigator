// Display math checked against independent references: JPL Horizons for the Earth's phase,
// the engine's own fixtures for directions, and the real data files for sizes and lighting.
import { describe, expect, it } from "vitest";
import { directionsAt, interpolateBody } from "../../engine/astro";
import type { ShadeGrid } from "../../engine/runtime-types";
import type { AltAzFixture, ShadeLabel, SiteList } from "../../engine/types";
import { azDiff, loadTimetable, readJson, REPO } from "../../engine/tests/audit/helpers";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  angularDiameterDeg, azDelta, azElToEnu, earthMonthFile, earthPhaseAngleDeg, litFraction, logRadius, meToThree,
  polarProject, polarUnproject, separationDeg, smoothHorizonDeg, validateCoordinates,
} from "./geometry";
import { cellLight, cellSkylineDeg, sampleGrid } from "./shade";
import horizons from "./fixtures/earth_phase_horizons.json";

const { label, values } = loadTimetable();
const REGION = { lat_min: -90, lat_max: -80 };

describe("angular size", () => {
  it("is 2 asin(radius / distance) with the engine's radii", () => {
    expect(angularDiameterDeg("sun", 149_597_870.7)).toBeCloseTo((2 * Math.asin(695_700 / 149_597_870.7) * 180) / Math.PI, 12);
    expect(angularDiameterDeg("earth", 384_400)).toBeCloseTo((2 * Math.asin(6356.7519 / 384_400) * 180) / Math.PI, 12);
  });

  it("stays in the expected range over the whole timetable", () => {
    let sun = [Infinity, -Infinity];
    let earth = [Infinity, -Infinity];
    for (let i = 0; i < label.count; i += 24) {
      const t = label.t0_ms + i * label.step_s * 1000;
      const d = directionsAt(values, label, t, -89.5, 0, 0, 0);
      const s = angularDiameterDeg("sun", d.sun.distance_km);
      const e = angularDiameterDeg("earth", d.earth.distance_km);
      sun = [Math.min(sun[0], s), Math.max(sun[1], s)];
      earth = [Math.min(earth[0], e), Math.max(earth[1], e)];
    }
    expect(sun[0]).toBeGreaterThan(0.52);
    expect(sun[1]).toBeLessThan(0.545);
    expect(earth[0]).toBeGreaterThan(1.78);
    expect(earth[1]).toBeLessThan(2.06);
  });
});

describe("Earth phase", () => {
  it("lit fraction is (1 + cos phase) / 2", () => {
    expect(litFraction(0)).toBe(1);
    expect(litFraction(90)).toBeCloseTo(0.5, 12);
    expect(litFraction(180)).toBeCloseTo(0, 12);
    expect(litFraction(60)).toBeCloseTo(0.75, 12);
  });

  it.each(horizons.cases)("matches JPL Horizons at $utc", (fixture) => {
    const t = Date.parse(fixture.utc);
    const sun = interpolateBody(values, label, t, 0);
    const earth = interpolateBody(values, label, t, 3);
    const phase = earthPhaseAngleDeg(sun, earth, { x: 0, y: 0, z: 0 });
    expect(Math.abs(phase - fixture.phase_angle_deg)).toBeLessThan(0.02);
    expect(Math.abs(litFraction(phase) * 100 - fixture.illuminated_percent)).toBeLessThan(0.02);
  });
});

describe("timetable interpolation as the scenes use it", () => {
  it("reproduces every altaz.json case within 0.01 degrees", () => {
    const fixture = readJson<AltAzFixture>("web/engine/tests/fixtures/altaz.json");
    for (const c of fixture.cases) {
      const d = directionsAt(values, label, c.t_ms, c.lat, c.lon, c.elev_m, c.mast_m);
      expect(Math.abs(d.sun.el_deg - c.sunEl)).toBeLessThan(0.01);
      expect(azDiff(d.sun.az_deg, c.sunAz) * Math.cos((c.sunEl * Math.PI) / 180)).toBeLessThan(0.01);
      expect(Math.abs(d.earth.el_deg - c.earthEl)).toBeLessThan(0.01);
      expect(azDiff(d.earth.az_deg, c.earthAz) * Math.cos((c.earthEl * Math.PI) / 180)).toBeLessThan(0.01);
    }
  });
});

describe("coordinate validation", () => {
  it("accepts points inside the region", () => {
    expect(validateCoordinates("-89.45", "-137.16", REGION)).toEqual({ ok: true, lat: -89.45, lon: -137.16 });
    expect(validateCoordinates(" -80 ", "180", REGION)).toEqual({ ok: true, lat: -80, lon: 180 });
    expect(validateCoordinates("-90", "0", REGION)).toEqual({ ok: true, lat: -90, lon: 0 });
  });

  it.each([
    ["", "10", "Enter both"],
    ["abc", "10", "not a number"],
    ["-85", "12e", "not a number"],
    ["-95", "10", "does not exist"],
    ["-79.99", "10", "outside the south polar region"],
    ["45", "10", "outside the south polar region"],
    ["-85", "181", "out of range"],
    ["-85", "-180.5", "out of range"],
  ])("refuses latitude %j, longitude %j", (lat, lon, phrase) => {
    const result = validateCoordinates(lat, lon, REGION);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(phrase);
  });
});

describe("polar stereographic projection", () => {
  const R = 1_737_400;

  it("round-trips every curated site", () => {
    for (const site of readJson<SiteList>("web/public/data/sites.json").sites) {
      const { x, y } = polarProject(site.lat, site.lon, R);
      const back = polarUnproject(x, y, R);
      expect(back.lat).toBeCloseTo(site.lat, 9);
      expect(azDelta(back.lon, site.lon)).toBeCloseTo(0, 9);
    }
  });

  it("puts longitude 0 up, 90 E right, and 80 S at the hillshade's edge", () => {
    const sidecar = readJson<{ x_max_m: number; sphere_radius_m: number }>("web/public/assets/hillshade/south_pole_hillshade.json");
    expect(sidecar.sphere_radius_m).toBe(R);
    const up = polarProject(-80, 0, R);
    const right = polarProject(-80, 90, R);
    expect(up.x).toBeCloseTo(0, 6);
    expect(right.y).toBeCloseTo(0, 6);
    expect(Math.abs(up.y - sidecar.x_max_m)).toBeLessThan(200);
    expect(Math.abs(right.x - sidecar.x_max_m)).toBeLessThan(200);
    expect(Math.hypot(polarProject(-90, 123, R).x, polarProject(-90, 123, R).y)).toBeLessThan(1e-6);
  });
});

describe("small helpers", () => {
  it("log scale maps equal ratios to equal steps", () => {
    expect(logRadius(1e5, 1e5, 1e9, 10, 410)).toBeCloseTo(10, 9);
    expect(logRadius(1e9, 1e5, 1e9, 10, 410)).toBeCloseTo(410, 9);
    expect(logRadius(1e7, 1e5, 1e9, 10, 410)).toBeCloseTo(210, 9);
  });

  it("separation, axes, month file and horizon", () => {
    expect(separationDeg({ x: 1, y: 0, z: 0 }, { x: 0, y: 5, z: 0 })).toBeCloseTo(90, 9);
    expect(meToThree({ x: 0, y: 2, z: -1 })).toEqual([0, -1, -2]);
    expect(meToThree({ x: 0, y: 1, z: 0 })).toEqual([0, 0, -1]);
    expect(azElToEnu(90, 0)[0]).toBeCloseTo(1, 12);
    expect(azElToEnu(0, 90)[2]).toBeCloseTo(1, 12);
    expect(earthMonthFile(Date.UTC(2026, 10, 16))).toBe("earth/bmng_11.jpg");
    expect(earthMonthFile(Date.UTC(2027, 0, 1))).toBe("earth/bmng_01.jpg");
    expect(smoothHorizonDeg(0)).toBeCloseTo(0, 12);
    expect(smoothHorizonDeg(2)).toBeCloseTo(-0.087, 3); // the handoff's value for a 2 m mast
    expect(azDelta(359, 1)).toBeCloseTo(-2, 12);
  });
});

describe("shade grid lighting on real data", () => {
  const id = "shackleton_rim";
  const shadeLabel = readJson<ShadeLabel>(`web/public/data/shade/${id}.json`);
  const read = (name: string) => readFileSync(resolve(REPO, `web/public/data/shade/${name}`));
  const sky = read(`${id}_skyline.bin`);
  const nor = read(`${id}_normal.bin`);
  const grid: ShadeGrid = {
    label: shadeLabel,
    skyline: new Int16Array(sky.buffer.slice(sky.byteOffset, sky.byteOffset + sky.byteLength)),
    normal: new Float32Array(nor.buffer.slice(nor.byteOffset, nor.byteOffset + nor.byteLength)),
  };

  it("gives no light when the Sun is far below every skyline and some when it is high", () => {
    const below = cellLight(grid, { az_deg: 40, el_deg: -30, distance_km: 1.5e8 });
    expect(Math.max(...below)).toBe(0);
    const high = cellLight(grid, { az_deg: 40, el_deg: 60, distance_km: 1.5e8 });
    expect(Math.min(...high)).toBeGreaterThan(0.3);
    expect(Math.max(...high)).toBeLessThanOrEqual(1);
  });

  it("darkens exactly the cells whose skyline is above the Sun", () => {
    const sun = { az_deg: 200, el_deg: 1.0, distance_km: 1.5e8 };
    const light = cellLight(grid, sun);
    const n = shadeLabel.n;
    for (let row = 0; row < n; row += 1) {
      for (let column = 0; column < n; column += 1) {
        const skyline = cellSkylineDeg(grid, row, column, sun.az_deg);
        if (skyline > sun.el_deg + 0.3) expect(light[row * n + column]).toBe(0);
      }
    }
  });

  it("interpolates between cells and clamps at the edges", () => {
    const v = new Float32Array([0, 1, 2, 3]);
    expect(sampleGrid(v, 2, 0.5, 0.5)).toBeCloseTo(1.5, 12);
    expect(sampleGrid(v, 2, 0, 1)).toBeCloseTo(1, 12);
    expect(sampleGrid(v, 2, -3, 9)).toBeCloseTo(1, 12);
  });
});
