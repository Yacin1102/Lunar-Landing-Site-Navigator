import { describe, expect, it } from "vitest";
import realSites from "../../public/data/sites.json";
import type { SiteList } from "../../engine/types";
import { categoryHeading, formatLatLon, groupByCategory } from "./sites";

const real = realSites as SiteList;

describe("site list helpers", () => {
  it("groups the real sites without losing or inventing any", () => {
    const groups = groupByCategory(real.sites);
    expect(groups.flatMap((group) => group.sites.map((site) => site.id)).sort()).toEqual(real.sites.map((site) => site.id).sort());
    expect(groups.map((group) => group.category)).toEqual([...new Set(real.sites.map((site) => site.category))]);
  });

  it("writes headings from whatever category ids appear", () => {
    expect(categoryHeading("high_illumination")).toBe("High illumination");
    expect(categoryHeading("psr")).toBe("Permanently shadowed");
    expect(categoryHeading("landing-site")).toBe("Landing site");
  });

  it("writes positions with hemisphere letters and units", () => {
    expect(formatLatLon(-89.4505, -137.16)).toBe("89.4505° S, 137.1600° W");
    expect(formatLatLon(-88.8247, 124.1359)).toBe("88.8247° S, 124.1359° E");
    expect(formatLatLon(-85, 0, 1)).toBe("85.0° S, 0.0° E");
  });
});
