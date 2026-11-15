// Audit: Sun and Earth directions at a site. Expected values come from SPICE (altaz.json, made
// by python/scripts/build_fixtures.py without the timetable), JPL Horizons (saved answers in
// python/tests/data/horizons_altaz.json) and hand calculation.
import { describe, expect, it } from "vitest";
import { directionFromBody, directionsAt, localBasis, MOON_RADIUS_KM, sitePosition } from "../../astro";
import type { AltAzFixture } from "../../types";
import { azDiff, loadTimetable, readJson } from "./helpers";

const { label, values } = loadTimetable();

describe("directions against SPICE and JPL Horizons", () => {
  it("passes every altaz.json case within 0.01 degrees", () => {
    const fixture = readJson<AltAzFixture>("web/engine/tests/fixtures/altaz.json");
    let worst = 0;
    for (const c of fixture.cases) {
      const d = directionsAt(values, label, c.t_ms, c.lat, c.lon, c.elev_m, c.mast_m);
      const errors = [Math.abs(d.sun.el_deg - c.sunEl), azDiff(d.sun.az_deg, c.sunAz),
        Math.abs(d.earth.el_deg - c.earthEl), azDiff(d.earth.az_deg, c.earthAz)];
      worst = Math.max(worst, ...errors);
      expect(Math.max(...errors), c.name).toBeLessThan(0.01);
    }
    console.log(`altaz.json (${fixture.cases.length} SPICE cases): worst error ${worst.toExponential(2)} deg (pass mark 0.01)`);
  });

  it("agrees with the saved JPL Horizons answers", () => {
    const horizons = readJson<{ results: Array<{ body: string; lat: number; lon: number; elev_m: number; rows: Array<{ t_ms: number; az_deg: number; el_deg: number }> }> }>("python/tests/data/horizons_altaz.json");
    let worst = 0;
    let count = 0;
    for (const result of horizons.results) {
      for (const row of result.rows) {
        const d = directionsAt(values, label, row.t_ms, result.lat, result.lon, result.elev_m, 0)[result.body === "SUN" ? "sun" : "earth"];
        worst = Math.max(worst, azDiff(d.az_deg, row.az_deg), Math.abs(d.el_deg - row.el_deg));
        count += 1;
      }
    }
    console.log(`JPL Horizons (${count} rows): worst difference ${worst.toExponential(2)} deg`);
    expect(worst).toBeLessThan(0.01);
  });
});

describe("geometry by hand", () => {
  it("puts the eye at R + elev + mast along the local vertical", () => {
    const p = sitePosition(-90, 0, 2500);
    expect(p.z).toBeCloseTo(-(MOON_RADIUS_KM + 2.5), 9);
    expect(Math.hypot(p.x, p.y)).toBeLessThan(1e-9);
  });

  it("has east, north and up orthonormal and right-handed, even 1e-5 degrees from the pole", () => {
    for (const [lat, lon] of [[-89.99999, 0], [-89.99999, 137], [-85, -180], [-80, 45]]) {
      const { east, north, up } = localBasis(lat, lon);
      const dot = (a: typeof east, b: typeof east) => a.x * b.x + a.y * b.y + a.z * b.z;
      expect(dot(east, north)).toBeCloseTo(0, 12);
      expect(dot(east, up)).toBeCloseTo(0, 12);
      expect(dot(north, up)).toBeCloseTo(0, 12);
      // east x north = up
      expect(east.y * north.z - east.z * north.y).toBeCloseTo(up.x, 12);
      expect(east.z * north.x - east.x * north.z).toBeCloseTo(up.y, 12);
      expect(east.x * north.y - east.y * north.x).toBeCloseTo(up.z, 12);
      // At these sites north points away from the south pole: its z component is positive.
      expect(north.z).toBeGreaterThan(0);
    }
  });

  it("gives elevation 90 straight up, and azimuth 90 / 180 for bodies due east / due south", () => {
    const lat = -85;
    const lon = 30;
    const eye = sitePosition(lat, lon, 0);
    const { east, north, up } = localBasis(lat, lon);
    const at = (v: typeof east, km: number) => ({ x: eye.x + v.x * km, y: eye.y + v.y * km, z: eye.z + v.z * km });
    expect(directionFromBody(at(up, 1e6), lat, lon, 0).el_deg).toBeCloseTo(90, 9);
    const e = directionFromBody(at(east, 1e6), lat, lon, 0);
    expect(e.az_deg).toBeCloseTo(90, 9);
    expect(e.el_deg).toBeCloseTo(0, 9);
    const s = directionFromBody(at({ x: -north.x, y: -north.y, z: -north.z }, 1e6), lat, lon, 0);
    expect(s.az_deg).toBeCloseTo(180, 9);
  });

  it("includes parallax: the Earth seen from the site differs from the Moon-centre direction", () => {
    // Earth on the site's horizon plane at 384,400 km: from the site it is level; from the Moon's
    // centre it would be 0.259 degrees higher (asin(1737.4 / 384400)).
    const lat = -88;
    const lon = 0;
    const eye = sitePosition(lat, lon, 0);
    const { north } = localBasis(lat, lon);
    const earth = { x: eye.x + north.x * 384400, y: eye.y + north.y * 384400, z: eye.z + north.z * 384400 };
    expect(directionFromBody(earth, lat, lon, 0).el_deg).toBeCloseTo(0, 9);
  });

  it("returns finite angles at the pole itself (moved to -89.99999)", () => {
    const d = directionFromBody({ x: 1.5e8, y: 1e6, z: -2e6 }, -90, 0, 0);
    expect(Number.isFinite(d.az_deg) && Number.isFinite(d.el_deg)).toBe(true);
  });
});
