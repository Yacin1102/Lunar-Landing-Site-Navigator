import { describe, expect, it, vi } from "vitest";
import { loadDataBundle } from "./data";

describe("prepared data loading", () => {
  it("uses labels to decode every prepared product", async () => {
    const json: Record<string, unknown> = {
      "/mock/manifest.json": {
        version: 1,
        data_kind: "mock",
        built_ms: 0,
        service_region: { lat_min: -90, lat_max: -80 },
        files: [],
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
        count: 1,
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
      ["/mock/ephem.bin", new Float32Array(6).buffer],
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
    expect(result.ephemeris.values).toHaveLength(6);
    expect(result.terrain.get("alpha")?.values[0]).toBe(0);
    expect(result.shade.get("alpha")?.skyline[2]).toBe(200);
  });
});
