// Audit: how much of a disc clears the skyline, and the lit / blocked / uncertain verdict.
// Expected values: the circle-segment formula, a brute-force area count written here, and the
// approved rule (docs/PROGRESS.md, decided 2026-11-15).
import { describe, expect, it } from "vitest";
import { discRadiusDeg, EARTH_RADIUS_KM, skylineAt, SUN_RADIUS_KM } from "../../astro";
import { classifyVisibility, discClearanceDeg, discMarginDeg, flatDiscErrorDeg, visibleDiscFraction } from "../../visibility";
import type { Skyline } from "../../types";
import { flatSkyline, readJson, seeded } from "./helpers";

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
    // Against skyline + error + the flat-disc elevation margin (2.0e-6 degrees here).
    const margin = flatDiscErrorDeg(0.1, RHO).el;
    expect(margin).toBeGreaterThan(0);
    expect(margin).toBeLessThan(3e-6);
    expect(v.fraction_low).toBeCloseTo(segmentFraction((0.1 - 0.03 - margin) / RHO), 9);
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

// ---------------------------------------------------------------------------------------------
// The real sky is a sphere, not a plane. These checks build every disc point on the sphere with
// vectors (east, north, up), so they share nothing with the engine's flat tangent-plane model.

const D2R = Math.PI / 180;

/**
 * The point at angular distance `rDeg` and position angle `theta` (radians, from "up" towards
 * increasing azimuth) from a centre (azimuth, elevation) on the real sky, degrees.
 */
function skyPoint(azDeg: number, elDeg: number, rDeg: number, theta: number): { az: number; el: number } {
  const [a, e, r] = [azDeg * D2R, elDeg * D2R, rDeg * D2R];
  const centre = [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
  const towardsUp = [-Math.sin(e) * Math.sin(a), -Math.sin(e) * Math.cos(a), Math.cos(e)];
  const towardsAz = [Math.cos(a), -Math.sin(a), 0];
  const p = [0, 1, 2].map((i) => Math.cos(r) * centre[i] + Math.sin(r) * (Math.cos(theta) * towardsUp[i] + Math.sin(theta) * towardsAz[i]));
  return { az: ((Math.atan2(p[0], p[1]) / D2R) % 360 + 360) % 360, el: Math.asin(p[2]) / D2R };
}

/**
 * Whether any of the real disc is above a step skyline. Only the rim is tested: from any visible
 * point, going straight up stays at the same azimuth and in the disc until it reaches the rim,
 * so a visible disc always has a visible rim point. 40,000 rim points, about 1e-4 degrees apart.
 */
function trulyVisible(azDeg: number, elDeg: number, rho: number, sky: Skyline): boolean {
  const samples = 40_000;
  for (let i = 0; i < samples; i += 1) {
    const p = skyPoint(azDeg, elDeg, rho, (2 * Math.PI * i) / samples);
    if (p.el > skylineAt(sky.skyline_deg, sky.az_step_deg, p.az)) return true;
  }
  return false;
}

describe("the flat disc model against the real sphere", () => {
  it("never misplaces a point of the disc by more than the proven bounds, which are close to the truth", () => {
    const rows: string[] = [];
    for (const [body, distance] of [["sun", 1.471e8], ["earth", 356_400]] as const) {
      const rho = discRadiusDeg(body, distance);
      for (const e of [-10, -1, 0, 1, 5, 11.6, 17, 25]) {
        let worstEl = 0;
        let worstAz = 0;
        for (let i = 1; i <= 40; i += 1) {
          const r = (rho * i) / 40;
          for (let j = 0; j < 720; j += 1) {
            const theta = (2 * Math.PI * j) / 720;
            const p = skyPoint(100, e, r, theta);
            worstEl = Math.max(worstEl, Math.abs(p.el - (e + r * Math.cos(theta))));
            worstAz = Math.max(worstAz, Math.abs(p.az - (100 + (r * Math.sin(theta)) / Math.cos(e * D2R))));
          }
        }
        const bound = flatDiscErrorDeg(e, rho);
        expect(worstEl, `${body} el ${e}`).toBeLessThanOrEqual(bound.el);
        expect(worstAz, `${body} el ${e}`).toBeLessThanOrEqual(bound.az);
        if (Math.abs(e) >= 5) {
          expect(worstEl / bound.el, `${body} el ${e}: elevation bound is tight`).toBeGreaterThan(0.8);
          expect(worstAz / bound.az, `${body} el ${e}: azimuth bound within 4 times`).toBeGreaterThan(0.25);
        }
        rows.push(`${body} el ${String(e).padStart(5)}: elevation ${worstEl.toExponential(2)} <= ${bound.el.toExponential(2)}, azimuth ${worstAz.toExponential(2)} <= ${bound.az.toExponential(2)}`);
      }
    }
    console.log(`flat-disc error, measured on the sphere <= proven bound (degrees):\n  ${rows.join("\n  ")}`);
  });

  it("gives a lit or blocked verdict that the real sphere confirms, where the flat model alone fails", () => {
    // Adversarial skylines: a wall 5 degrees above the disc with one notch 1 to 3 wedges wide near
    // the disc's edge, its floor within 0.006 degrees of the flat model's disc top in that notch.
    const random = seeded(20261116);
    let flatWrong = 0;
    let uncertain = 0;
    const cases = 400;
    for (let c = 0; c < cases; c += 1) {
      const body = random() < 0.5 ? "sun" : "earth";
      const el = body === "sun" ? -1 + 12.6 * random() : -1 + 18 * random();
      const distance = body === "sun" ? 1.471e8 + 0.05e8 * random() : 356_400 + 50_000 * random();
      const az = 360 * random();
      const rho = discRadiusDeg(body, distance);
      const sky = flatSkyline(el + 5, 0, 0.1);
      const n = sky.skyline_deg.length;
      const cosEl = Math.cos(el * D2R);
      const width = 1 + Math.floor(3 * random());
      const kStart = Math.round((az + (2.3 * random() - 1.15) * (rho / cosEl)) / 0.1);
      const x1 = ((kStart - 0.5) * 0.1 - az) * cosEl;
      const x2 = ((kStart + width - 0.5) * 0.1 - az) * cosEl;
      const nearest = x1 <= 0 && x2 >= 0 ? 0 : Math.min(Math.abs(x1), Math.abs(x2));
      const flatTop = el + Math.sqrt(Math.max(0, rho * rho - nearest * nearest));
      const floor = flatTop + (2 * random() - 1) * 0.006;
      for (let k = kStart; k < kStart + width; k += 1) sky.skyline_deg[((k % n) + n) % n] = floor;

      const direction = { az_deg: az, el_deg: el, distance_km: distance };
      const truth = trulyVisible(az, el, rho, sky);
      const verdict = classifyVisibility(direction, body, sky).status;
      if (verdict === "visible") expect(truth, `case ${c}: called lit, but the real disc is hidden`).toBe(true);
      if (verdict === "blocked") expect(truth, `case ${c}: called blocked, but the real disc shows`).toBe(false);
      if (verdict === "uncertain") uncertain += 1;
      if ((visibleDiscFraction(direction, body, sky, 0) > 0) !== truth) flatWrong += 1;
    }
    console.log(`${cases} adversarial notches: flat model alone wrong in ${flatWrong}; with the margins 0 wrong, ${uncertain} uncertain`);
    expect(flatWrong).toBeGreaterThan(0);
  }, 120_000);
});

describe("the margin the event search follows", () => {
  it("is positive exactly when some of the disc is clear, for every shift", () => {
    const random = seeded(7);
    let checked = 0;
    for (let c = 0; c < 3000; c += 1) {
      const sky = flatSkyline(0, 0, 0.1);
      for (let k = 0; k < sky.skyline_deg.length; k += 1) {
        sky.skyline_deg[k] = 2 * random() - 1;
        sky.skyline_err_deg[k] = 0.2 * random();
      }
      const body = random() < 0.5 ? "sun" : "earth";
      const direction = { az_deg: 360 * random(), el_deg: 3 * random() - 1.5, distance_km: body === "sun" ? 1.496e8 : 384_400 };
      for (const shift of [1, 0, -1] as const) {
        const margin = discMarginDeg(direction, body, sky, shift);
        const fraction = visibleDiscFraction(direction, body, sky, shift);
        if (Math.abs(margin) < 1e-9) continue;
        expect(fraction > 0, `case ${c}, shift ${shift}, margin ${margin}`).toBe(margin > 0);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(8900);
  });

  it("does not jump when a disc edge crosses a wedge boundary, unlike the clearance", () => {
    // A notch one wedge wide, 1 degree deep: as the disc slides across it in tiny steps the
    // clearance jumps the moment the disc's edge reaches the notch; the margin moves no faster
    // than the disc does.
    const sky = flatSkyline(1, 0, 0.1);
    sky.skyline_deg[1000] = 0; // the wedge from 99.95 to 100.05 degrees
    const stepDeg = 1e-4;
    let worstMargin = 0;
    let worstClearance = 0;
    let prev = { m: NaN, c: NaN };
    for (let az = 99; az < 101; az += stepDeg) {
      const direction = { az_deg: az, el_deg: 0.5, distance_km: 1.496e8 };
      const now = { m: discMarginDeg(direction, "sun", sky, 0), c: discClearanceDeg(direction, "sun", sky, 0) };
      if (Number.isFinite(prev.m)) {
        worstMargin = Math.max(worstMargin, Math.abs(now.m - prev.m));
        worstClearance = Math.max(worstClearance, Math.abs(now.c - prev.c));
      }
      prev = now;
    }
    expect(worstMargin).toBeLessThanOrEqual(stepDeg * 1.0001);
    expect(worstClearance).toBeGreaterThan(0.05);
  });
});
