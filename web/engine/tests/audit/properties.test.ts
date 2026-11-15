// Audit: properties that must hold for any input, checked on many seeded random cases.
import { describe, expect, it } from "vitest";
import { directionFromBody, directionsAt, timetableSpan } from "../../astro";
import { classifyVisibility, visibleDiscFraction } from "../../visibility";
import { panelPowerW, simulateBattery, type PanelSettings } from "../../power";
import type { Skyline } from "../../types";
import { loadTimetable, seeded } from "./helpers";

const random = seeded(20261115);
const between = (lo: number, hi: number) => lo + (hi - lo) * random();

/** A rough random skyline: smooth hills plus one-wedge spikes, with random errors. */
function randomSkyline(step: number): Skyline {
  const n = Math.round(360 / step);
  const phase = between(0, 2 * Math.PI);
  const skyline_deg = Array.from({ length: n }, (_, k) => 2 * Math.sin(phase + (k * step * Math.PI) / 45) + (random() < 0.02 ? between(0, 5) : 0));
  const skyline_err_deg = Array.from({ length: n }, () => between(0, 0.1));
  return { version: 1, lat: -89, lon: 0, elev_m: 0, mast_m: 2, az_step_deg: step, skyline_deg, skyline_err_deg, dem: ["TEST"], resolution_m: 1, max_reach_km: 1 };
}

describe("properties", () => {
  it("the visible fraction never decreases as the Sun rises relative to the terrain (exact)", () => {
    // Raising the Sun by s relative to a fixed skyline, with the disc's shape on the sky held
    // fixed, is the same as lowering every skyline entry by s. This must never lose any disc.
    for (let trial = 0; trial < 60; trial += 1) {
      const sky = randomSkyline([0.05, 0.1, 0.25, 1][trial % 4]);
      const direction = { az_deg: between(0, 360), el_deg: between(-3, 3), distance_km: 1.5e8 };
      let previous = -1;
      for (let s = -8; s <= 8; s += 0.01) {
        const lowered = { ...sky, skyline_deg: sky.skyline_deg.map((h) => h - s) };
        const f = visibleDiscFraction(direction, "sun", lowered);
        expect(f).toBeGreaterThanOrEqual(previous - 1e-12);
        previous = f;
      }
      expect(previous).toBe(1);
    }
  });

  it("on the real sky, rising can only lose disc through the azimuth stretch, within its bound", () => {
    // As a disc rises its edge points spread in azimuth (offset = arc / cos(elevation)), so the
    // strip of the disc inside a narrow low wedge narrows. To first order each wedge edge inside
    // the disc moves by at most (rho / cos el) * |cos el2 - cos el1| across a chord of at most
    // 2 rho; a drop larger than the sum over the edges would be a bug.
    const rhoKm = 1.5e8;
    let largestDrop = 0;
    for (let trial = 0; trial < 60; trial += 1) {
      const sky = randomSkyline([0.05, 0.1, 0.25, 1][trial % 4]);
      const az = between(0, 360);
      let previous = -1;
      let previousEl = -8;
      for (let el = -8; el <= 8; el += 0.01) {
        const f = visibleDiscFraction({ az_deg: az, el_deg: el, distance_km: rhoKm }, "sun", sky);
        if (previous >= 0) {
          const rho = Math.asin(695700 / rhoKm) * 180 / Math.PI;
          const cos1 = Math.cos(previousEl * Math.PI / 180);
          const cos2 = Math.cos(el * Math.PI / 180);
          const edges = Math.ceil(2 * rho / cos2 / sky.az_step_deg) + 1;
          const bound = edges * 2 * rho * (rho / cos2) * Math.abs(cos2 - cos1) / (Math.PI * rho * rho);
          largestDrop = Math.max(largestDrop, previous - f);
          expect(previous - f).toBeLessThanOrEqual(bound + 1e-12);
        }
        previous = f;
        previousEl = el;
      }
      expect(previous).toBe(1);
    }
    console.log(`largest drop of the visible fraction in one 0.01 degree rise: ${largestDrop.toExponential(2)} (stretch effect)`);
  });

  it("fractions are finite, within [0, 1], and ordered low <= nominal <= high", () => {
    for (let trial = 0; trial < 3000; trial += 1) {
      const sky = randomSkyline([0.1, 1][trial % 2]);
      const body = trial % 3 === 0 ? "earth" : "sun";
      const v = classifyVisibility({ az_deg: between(-720, 720), el_deg: between(-10, 10), distance_km: body === "sun" ? 1.5e8 : between(356000, 407000) }, body, sky);
      for (const f of [v.fraction, v.fraction_low, v.fraction_high]) {
        expect(Number.isFinite(f) && f >= 0 && f <= 1).toBe(true);
      }
      expect(v.fraction_low).toBeLessThanOrEqual(v.fraction + 1e-12);
      expect(v.fraction).toBeLessThanOrEqual(v.fraction_high + 1e-12);
    }
  });

  it("azimuth is always in [0, 360) and nothing is NaN, for any site from 80 S to the pole", () => {
    const { label, values } = loadTimetable();
    const span = timetableSpan(label);
    for (let trial = 0; trial < 3000; trial += 1) {
      const lat = trial === 0 ? -90 : between(-90, -80);
      const lon = between(-180, 180);
      const d = directionsAt(values, label, between(span.startMs, span.endMs), lat, lon, between(-5000, 8000), between(0, 100));
      for (const b of [d.sun, d.earth]) {
        expect(b.az_deg >= 0 && b.az_deg < 360).toBe(true);
        expect(Number.isFinite(b.el_deg) && Number.isFinite(b.distance_km)).toBe(true);
      }
    }
    // Vectors pointing exactly along the axes, where atan2 sits on its branch cut.
    for (const v of [{ x: 0, y: 0, z: 1e8 }, { x: 0, y: 0, z: -1e8 }, { x: -1e8, y: -1e-9, z: 0 }]) {
      const d = directionFromBody(v, -89.99999, 0, 0);
      expect(d.az_deg >= 0 && d.az_deg < 360 && Number.isFinite(d.el_deg)).toBe(true);
    }
  });

  it("energy is never negative and the battery stays between 0 and its capacity", () => {
    const panels: PanelSettings[] = [
      { type: "flat", area_m2: 2, efficiency: 0.3 },
      { type: "tracking", area_m2: 2, efficiency: 0.3 },
      { type: "fixed", area_m2: 2, efficiency: 0.3, tilt_deg: 90, az_deg: 0 },
    ];
    for (let trial = 0; trial < 300; trial += 1) {
      const panel = panels[trial % 3];
      const samples = Array.from({ length: 50 }, (_, i) => ({
        time_ms: i * 3600000,
        sun: { az_deg: between(0, 360), el_deg: between(-5, 5), distance_km: 1.5e8 },
        visible_fraction: random(),
      }));
      for (const s of samples) expect(panelPowerW(s.sun, s.visible_fraction, panel)).toBeGreaterThanOrEqual(0);
      const capacity = between(10, 5000);
      const b = simulateBattery(samples, panel, { capacity_Wh: capacity, initial_Wh: between(-100, 6000), load_W: between(0, 400) });
      expect(b.energy_produced_Wh).toBeGreaterThanOrEqual(0);
      for (const c of b.charge_Wh) expect(c.charge_Wh >= 0 && c.charge_Wh <= capacity).toBe(true);
      if (b.battery_runs_out_ms !== undefined) {
        expect(b.battery_runs_out_ms).toBeGreaterThanOrEqual(0);
        expect(b.battery_runs_out_ms).toBeLessThanOrEqual(samples[samples.length - 1].time_ms);
      }
    }
  });
});
