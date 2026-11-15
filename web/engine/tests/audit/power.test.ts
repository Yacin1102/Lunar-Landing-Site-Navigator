// Audit: sunlight, panels and battery. Expected values are hand calculations; the Sun's distance
// comes from the Python engine's reference values.
import { describe, expect, it } from "vitest";
import { AU_KM, fixedPanelIncidence, flatPanelIncidence, panelPowerW, simulateBattery, solarIrradianceWm2 } from "../../power";
import { readJson } from "./helpers";

const night = { az_deg: 0, el_deg: -5, distance_km: AU_KM };

describe("irradiance", () => {
  it("is 1361 W/m^2 x fraction at 1 AU, with AU = 149,597,870.7 km", () => {
    expect(AU_KM).toBe(149_597_870.7);
    expect(solarIrradianceWm2(AU_KM, 1)).toBe(1361);
    expect(solarIrradianceWm2(AU_KM, 0.25)).toBe(340.25);
    expect(solarIrradianceWm2(AU_KM, 1.7)).toBe(1361); // fraction clamped to 1
    expect(solarIrradianceWm2(AU_KM, -1)).toBe(0);
  });

  it("scales with (1 AU / d)^2 at the real Sun distance", () => {
    const c = readJson<{ cases: Array<{ sun_distance_km: number }> }>("web/engine/tests/audit/fixtures/python_reference.json").cases[0];
    // 16 Nov 2026: about 0.989 AU, so about 2.3 % more than at 1 AU.
    const expected = 1361 * (149_597_870.7 / c.sun_distance_km) ** 2;
    expect(solarIrradianceWm2(c.sun_distance_km, 1)).toBeCloseTo(expected, 9);
    expect(expected).toBeGreaterThan(1380);
    expect(expected).toBeLessThan(1400);
  });
});

describe("panel factors", () => {
  it("flat panel: sin(elevation), 0 below the horizon", () => {
    expect(flatPanelIncidence(30)).toBeCloseTo(0.5, 12);
    expect(flatPanelIncidence(-1)).toBe(0);
  });

  it("fixed panel: tilt from horizontal; 0 is flat, 90 is vertical facing az_deg", () => {
    expect(fixedPanelIncidence({ az_deg: 10, el_deg: 1 }, { tilt_deg: 0, az_deg: 0 })).toBeCloseTo(Math.sin(Math.PI / 180), 12);
    expect(fixedPanelIncidence({ az_deg: 90, el_deg: 0 }, { tilt_deg: 90, az_deg: 90 })).toBeCloseTo(1, 12);
    expect(fixedPanelIncidence({ az_deg: 270, el_deg: 0 }, { tilt_deg: 90, az_deg: 90 })).toBe(0);
    // Vertical panel facing north, Sun 60 degrees to the east at 0 elevation: cos 60 = 0.5.
    expect(fixedPanelIncidence({ az_deg: 60, el_deg: 0 }, { tilt_deg: 90, az_deg: 0 })).toBeCloseTo(0.5, 12);
  });
});

describe("battery", () => {
  const flat = { type: "flat" as const, area_m2: 1, efficiency: 0.3 };

  it("runs out at the moment the charge reaches 0, not at the next sample", () => {
    const b = simulateBattery([{ time_ms: 0, sun: night, visible_fraction: 0 }, { time_ms: 3600000, sun: night, visible_fraction: 0 }],
      flat, { capacity_Wh: 100, initial_Wh: 50, load_W: 100 });
    expect(b.battery_runs_out_ms).toBe(1800000); // 50 Wh at 100 W: half an hour
    expect(b.lowest_charge_Wh).toBe(0);
  });

  it("never goes above capacity, and counts energy in Wh with time in hours", () => {
    const sun = { az_deg: 0, el_deg: 90, distance_km: AU_KM };
    const b = simulateBattery([{ time_ms: 0, sun, visible_fraction: 1 }, { time_ms: 7200000, sun, visible_fraction: 1 }],
      flat, { capacity_Wh: 100, initial_Wh: 90, load_W: 0 });
    expect(b.energy_produced_Wh).toBeCloseTo(1361 * 0.3 * 2, 9); // 408.3 W for 2 h
    expect(b.charge_Wh[1].charge_Wh).toBe(100);
    expect(panelPowerW(sun, 1, flat)).toBeCloseTo(408.3, 9);
  });

  it("clamps the starting charge, also with no samples, and refuses impossible settings", () => {
    expect(simulateBattery([], flat, { capacity_Wh: 100, initial_Wh: 500, load_W: 1 }).lowest_charge_Wh).toBe(100);
    expect(() => simulateBattery([], flat, { capacity_Wh: 0, initial_Wh: 0, load_W: 1 })).toThrow(RangeError);
    expect(() => simulateBattery([], flat, { capacity_Wh: 10, initial_Wh: 0, load_W: -1 })).toThrow(RangeError);
    expect(() => simulateBattery([], flat, { capacity_Wh: Number.NaN, initial_Wh: 0, load_W: 1 })).toThrow(RangeError);
  });
});
