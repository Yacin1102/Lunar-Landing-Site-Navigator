import { describe, expect, it } from "vitest";
import { directionFromBody, discRadiusDeg, interpolateBody, skylineAt } from "./astro";
import { visibleDiscFraction } from "./visibility";

describe("astro core", () => {
  it("uses north-clockwise azimuth and degrees", () => {
    const direction = directionFromBody({ x: 384400, y: 0, z: 0 }, -90, 0, 0);
    expect(direction.az_deg).toBeCloseTo(0, 5);
    expect(direction.el_deg).toBeCloseTo(-0.259, 2);
  });

  it("interpolates a linear timetable without changing units", () => {
    const values = new Float32Array([
      0, 0, 0, 0, 0, 0,
      10, 0, 0, 10, 0, 0,
      20, 0, 0, 20, 0, 0,
      30, 0, 0, 30, 0, 0,
    ]);
    const result = interpolateBody(values, { t0_ms: 0, step_s: 1, count: 4 }, 1500, 0);
    expect(result.x).toBeCloseTo(15, 5);
  });

  it("returns a finite solar disc radius and wraps skyline seams", () => {
    expect(discRadiusDeg("sun", 149_600_000)).toBeGreaterThan(0.25);
    expect(skylineAt([1, 2, 3, 4], 90, 359)).toBeCloseTo(1.033, 2);
  });

  it("gives a full visible fraction when the disc is well above a flat skyline", () => {
    const fraction = visibleDiscFraction(
      { az_deg: 0, el_deg: 10, distance_km: 149_600_000 },
      "sun",
      {
        version: 1, lat: -89, lon: 0, elev_m: 0, mast_m: 0, az_step_deg: 90,
        skyline_deg: [0, 0, 0, 0], skyline_err_deg: [0, 0, 0, 0],
        dem: "test", resolution_m: 1, max_reach_km: 1,
      },
    );
    expect(fraction).toBe(1);
  });
});
