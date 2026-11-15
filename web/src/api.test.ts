import { describe, expect, it, vi } from "vitest";
import { fetchCustomSkyline } from "./api";

describe("custom skyline API", () => {
  it("turns a network failure into an explicit unavailable result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const result = await fetchCustomSkyline("http://localhost:8000", -89, 0);
    expect(result).toEqual({
      ok: false,
      kind: "unreachable",
      message: "Skyline service unreachable. Terrain not included; verdict unavailable.",
    });
  });

  it("returns a typed skyline on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      version: 1,
      lat: -89,
      lon: 0,
      elev_m: 0,
      mast_m: 2,
      az_step_deg: 90,
      skyline_deg: [0, 0, 0, 0],
      skyline_err_deg: [0.1, 0.1, 0.1, 0.1],
      dem: ["SYNTHETIC"],
      resolution_m: 10,
      max_reach_km: 10,
    }), { status: 200 })));
    const result = await fetchCustomSkyline("http://localhost:8000", -89, 0);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skyline.lat).toBe(-89);
  });
});
