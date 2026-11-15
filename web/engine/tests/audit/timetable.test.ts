// Audit: reading the timetable. Expected values come from the Python engine's reference method
// (ephemeris.interpolate_rows / view_from_rows) and from polynomials worked out by hand.
import { describe, expect, it } from "vitest";
import { directionFromBody, discRadiusDeg, interpolateBody, timetableSpan } from "../../astro";
import { azDiff, loadTimetable, readJson } from "./helpers";

interface PythonCase {
  name: string; t_ms: number; lat: number; lon: number; elev_m: number; mast_m: number;
  sun_km: number[]; earth_km: number[];
  sun_az: number; sun_el: number; sun_distance_km: number; sun_radius_deg: number;
  earth_az: number; earth_el: number; earth_distance_km: number; earth_radius_deg: number;
}

const reference = readJson<{ cases: PythonCase[] }>("web/engine/tests/audit/fixtures/python_reference.json");
const { label, values } = loadTimetable();

describe("timetable interpolation (against the Python engine)", () => {
  it("gives the same vectors as interpolate_rows, including the first and last interval", () => {
    let worstKm = 0;
    for (const c of reference.cases) {
      const sun = interpolateBody(values, label, c.t_ms, 0);
      const earth = interpolateBody(values, label, c.t_ms, 3);
      const diffs = [sun.x - c.sun_km[0], sun.y - c.sun_km[1], sun.z - c.sun_km[2],
        earth.x - c.earth_km[0], earth.y - c.earth_km[1], earth.z - c.earth_km[2]].map(Math.abs);
      worstKm = Math.max(worstKm, ...diffs);
    }
    console.log(`Lagrange vs Python interpolate_rows: worst ${worstKm.toExponential(2)} km over ${reference.cases.length} cases`);
    expect(worstKm).toBeLessThan(1e-6);
  });

  it("gives the same angles, distances and disc radii as view_from_rows", () => {
    let worstDeg = 0;
    for (const c of reference.cases) {
      for (const body of ["sun", "earth"] as const) {
        const v = interpolateBody(values, label, c.t_ms, body === "sun" ? 0 : 3);
        const d = directionFromBody(v, c.lat, c.lon, c.elev_m, c.mast_m);
        worstDeg = Math.max(worstDeg, azDiff(d.az_deg, c[`${body}_az`]), Math.abs(d.el_deg - c[`${body}_el`]),
          Math.abs(discRadiusDeg(body, d.distance_km) - c[`${body}_radius_deg`]));
        expect(Math.abs(d.distance_km - c[`${body}_distance_km`]), c.name).toBeLessThan(1e-6);
      }
    }
    console.log(`Directions vs Python view_from_rows: worst ${worstDeg.toExponential(2)} deg`);
    expect(worstDeg).toBeLessThan(1e-9);
  });

  it("is exact for a cubic in every interval, first and last included (4 nearest rows)", () => {
    // Rows of y = t^3 - 2t; a 4-point Lagrange cubic must reproduce it exactly anywhere.
    const count = 7;
    const rows = new Float32Array(6 * count);
    for (let i = 0; i < count; i += 1) rows[6 * i + 3] = i ** 3 - 2 * i;
    const small = { t0_ms: 1000, step_s: 2, count };
    for (const t of [0, 0.5, 0.99, 2.25, 3.5, 5.5, 5.999, 6]) {
      const exact = t ** 3 - 2 * t;
      expect(interpolateBody(rows, small, 1000 + t * 2000, 3).x, `t=${t}`).toBeCloseTo(exact, 9);
    }
  });

  it("refuses times outside the table instead of extrapolating", () => {
    const span = timetableSpan(label);
    expect(span.startMs).toBe(1794787200000);
    expect(span.endMs).toBe(2208988800000);
    expect(() => interpolateBody(values, label, span.startMs - 1, 0)).toThrow(RangeError);
    expect(() => interpolateBody(values, label, span.endMs + 1, 0)).toThrow(RangeError);
    expect(() => interpolateBody(values, label, Number.NaN, 0)).toThrow(RangeError);
    expect(() => interpolateBody(values, label, span.endMs, 0)).not.toThrow();
  });

  it("reads row i at t0 + i * step_s * 1000 (row index and fraction from the label)", () => {
    const i = 12345;
    const v = interpolateBody(values, label, label.t0_ms + i * label.step_s * 1000, 3);
    expect(v.x).toBe(values[6 * i + 3]);
    expect(v.y).toBe(values[6 * i + 4]);
    expect(v.z).toBe(values[6 * i + 5]);
  });
});
