import { describe, expect, it } from "vitest";
import type { TerrainPatch } from "../engine/runtime-types";
import { buildTerrainGeometry, directionToThree, gridToEastNorth } from "./terrain3d";

describe("terrain 3D coordinate helpers", () => {
  it("maps north, east, and up axes", () => {
    const direction = directionToThree({ az_deg: 90, el_deg: 0 });
    expect(direction.x).toBeCloseTo(1);
    expect(direction.y).toBeCloseTo(0);
    expect(direction.z).toBeCloseTo(0);
  });

  it("maps contract grid coordinates to metres", () => {
    expect(gridToEastNorth(0, 0, 3, 10)).toEqual({ eastM: -10, northM: 10 });
    expect(gridToEastNorth(1, 1, 3, 10)).toEqual({ eastM: 0, northM: 0 });
  });

  it("builds a mesh with one vertex per terrain sample", () => {
    const patch: TerrainPatch = {
      label: { version: 1, lat: -89, lon: 0, elev_m: 0, size_m: 20, n: 3, spacing_m: 10, dem: ["mock"], resolution_m: 10 },
      values: new Float32Array([0, 1, 0, 1, 2, 1, 0, 1, 0]),
    };
    expect(buildTerrainGeometry(patch, 1).getAttribute("position").count).toBe(9);
  });
});
