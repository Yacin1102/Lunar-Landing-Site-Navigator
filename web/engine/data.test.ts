import { describe, expect, it, vi } from "vitest";
import { checkEphemerisLabel, loadDataBundle } from "./data";
import type { EphemerisLabel } from "./runtime-types";

describe("timetable label", () => {
  const good = {
    version: 1, t0_ms: 0, step_s: 3600, count: 4,
    columns: ["sun_x", "sun_y", "sun_z", "earth_x", "earth_y", "earth_z"],
    units: "km", frame: "MOON_ME", origin: "MOON", aberration: "LT+S",
  } as unknown as EphemerisLabel;

  it("accepts the contract's columns, units, frame and origin", () => {
    expect(() => checkEphemerisLabel(good)).not.toThrow();
  });

  it("refuses columns in another order, other units, another frame or another origin", () => {
    const swapped = { ...good, columns: ["earth_x", "earth_y", "earth_z", "sun_x", "sun_y", "sun_z"] } as unknown as EphemerisLabel;
    expect(() => checkEphemerisLabel(swapped)).toThrow(/in that order/);
    expect(() => checkEphemerisLabel({ ...good, units: "m" } as unknown as EphemerisLabel)).toThrow(/units/);
    expect(() => checkEphemerisLabel({ ...good, frame: "J2000" } as unknown as EphemerisLabel)).toThrow(/frame/);
    expect(() => checkEphemerisLabel({ ...good, origin: "EARTH" } as unknown as EphemerisLabel)).toThrow(/origin/);
  });
});

describe("prepared data loading", () => {
  it("uses labels to decode every prepared product", async () => {
    const json: Record<string, unknown> = {
      "/mock/manifest.json": {
        version: 1,
        data_kind: "mock",
        built_ms: 0,
        service_region: { lat_min: -90, lat_max: -80 },
        files: [
          { path: "ephem.bin", contract: "ephem", version: 1, bytes: 96 },
          { path: "terrain/alpha.bin", contract: "terrain", version: 1, bytes: 4 },
          { path: "shade/alpha_skyline.bin", contract: "shade", version: 1, bytes: 8 },
          { path: "shade/alpha_normal.bin", contract: "shade", version: 1, bytes: 12 },
        ],
        sites: [{ id: "alpha", has_terrain: true, has_shade_grid: true }],
      },
      "/mock/sites.json": {
        version: 1,
        sites: [{ id: "alpha", name: "Alpha", lat: -89, lon: 10, category: "ridge", has_terrain: true, has_shade_grid: true }],
      },
      "/mock/ephem.json": {
        version: 1,
        t0_ms: 0,
        step_s: 3600,
        count: 4,
        columns: ["sun_x", "sun_y", "sun_z", "earth_x", "earth_y", "earth_z"],
        units: "km",
        frame: "MOON_ME",
        origin: "MOON",
        aberration: "none",
      },
      "/mock/skylines/alpha.json": {
        version: 1, lat: -89, lon: 10, elev_m: 0, mast_m: 2, az_step_deg: 90,
        skyline_deg: [0, 1, 2, 3], skyline_err_deg: [0.1, 0.1, 0.1, 0.1],
        dem: ["SYNTHETIC"], resolution_m: 10, max_reach_km: 1,
      },
      "/mock/terrain/alpha.json": {
        version: 1, lat: -89, lon: 10, elev_m: 0, size_m: 10, n: 1, spacing_m: 10,
        dem: ["SYNTHETIC"], resolution_m: 10,
      },
      "/mock/shade/alpha.json": {
        version: 1, center_lat: -89, center_lon: 10, size_m: 10, n: 1, spacing_m: 10,
        az_step_deg: 90, n_az: 4, skyline_scale: 100, mast_m: 2, dem: ["SYNTHETIC"], resolution_m: 10,
      },
    };
    const binary = new Map<string, ArrayBuffer>([
      ["/mock/ephem.bin", new Float32Array(24).buffer],
      ["/mock/terrain/alpha.bin", new Float32Array([0]).buffer],
      ["/mock/shade/alpha_skyline.bin", new Int16Array([0, 100, 200, 300]).buffer],
      ["/mock/shade/alpha_normal.bin", new Float32Array([0, 0, 1]).buffer],
    ]);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (binary.has(url)) return new Response(binary.get(url), { status: 200 });
      return new Response(JSON.stringify(json[url]), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await loadDataBundle("/mock");
    expect(result.ephemeris.values).toHaveLength(24);
    expect(result.terrain.get("alpha")?.values[0]).toBe(0);
    expect(result.shade.get("alpha")?.skyline[2]).toBe(200);
  });
});
