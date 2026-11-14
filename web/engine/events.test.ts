import { describe, expect, it } from "vitest";
import { findEvents } from "./events";

describe("event search", () => {
  it("returns empty lists when a body stays above the skyline", () => {
    const values = new Float32Array([
      384400, 0, 1000, -384400, 0, 1000,
      384400, 0, 1000, -384400, 0, 1000,
      384400, 0, 1000, -384400, 0, 1000,
    ]);
    const events = findEvents(
      values,
      {
        version: 1, t0_ms: 0, step_s: 600, count: 3,
        columns: ["sun_x", "sun_y", "sun_z", "earth_x", "earth_y", "earth_z"],
        units: "km", frame: "MOON_ME", origin: "MOON", aberration: "test",
      },
      {
        version: 1, lat: -90, lon: 0, elev_m: 0, mast_m: 0, az_step_deg: 90,
        skyline_deg: [0, 0, 0, 0], skyline_err_deg: [0, 0, 0, 0],
        dem: ["test"], resolution_m: 1, max_reach_km: 1,
      },
      { lat: -90, lon: 0, elev_m: 0 },
      0,
      1200000,
    );
    expect(events.sunrise).toHaveLength(0);
    expect(events.sunset).toHaveLength(0);
  });
});
