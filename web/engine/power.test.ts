import { describe, expect, it } from "vitest";
import { panelPowerW, simulateBattery, solarIrradianceWm2 } from "./power";
import type { Direction } from "./runtime-types";

const sun: Direction = { az_deg: 0, el_deg: 90, distance_km: 149_597_870.7 };

describe("power and battery", () => {
  it("scales solar irradiance by the visible disc fraction", () => {
    expect(solarIrradianceWm2(149_597_870.7, 0.5)).toBeCloseTo(680.5, 5);
  });

  it("matches the hand calculation for a flat one-square-metre panel", () => {
    expect(panelPowerW(sun, 1, { type: "flat", area_m2: 1, efficiency: 0.2 })).toBeCloseTo(272.2, 1);
  });

  it("tracks charge and records a battery runout", () => {
    const result = simulateBattery(
      [
        { time_ms: 0, sun, visible_fraction: 0 },
        { time_ms: 3600000, sun, visible_fraction: 0 },
        { time_ms: 7200000, sun, visible_fraction: 0 },
      ],
      { type: "flat", area_m2: 1, efficiency: 0.2 },
      { capacity_Wh: 100, initial_Wh: 10, load_W: 10 },
    );
    expect(result.energy_produced_Wh).toBe(0);
    expect(result.lowest_charge_Wh).toBe(0);
    expect(result.battery_runs_out_ms).toBe(3600000);
  });
});
