import { describe, expect, it } from "vitest";
import { formatRoute, parseRoute, type Route } from "./route";

describe("route", () => {
  it("round-trips every kind of route", () => {
    const routes: Route[] = [
      { view: "globe" },
      { view: "map", timeMs: 1794787200000 },
      { view: "site", siteId: "shackleton_rim", timeMs: 1800000000000 },
      { view: "point", lat: -89.45, lon: -137.16 },
      { view: "point", lat: -85, lon: 12.5, timeMs: 1794787200000 },
    ];
    for (const route of routes) expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it("opens the globe for an empty or unknown address", () => {
    expect(parseRoute("")).toEqual({ view: "globe" });
    expect(parseRoute("#/nowhere")).toEqual({ view: "globe" });
    expect(parseRoute("#/site/")).toEqual({ view: "globe" });
  });

  it("refuses a point that is not two numbers", () => {
    expect(parseRoute("#/point/abc,12")).toEqual({ view: "globe" });
    expect(parseRoute("#/point/-89")).toEqual({ view: "globe" });
    expect(parseRoute("#/point/-89,")).toEqual({ view: "globe" });
  });

  it("drops a time that is not a number", () => {
    expect(parseRoute("#/map?t=soon")).toEqual({ view: "map" });
    expect(parseRoute("#/map?t=")).toEqual({ view: "map" });
  });
});
