/**
 * The app's address: which scene is open, for which site or point, at which time.
 *
 * Role: one place that turns the URL hash into a typed route and back, so every view is a
 * shareable link and the browser's back button works.
 *
 * How it works: the hash is `#/globe`, `#/map`, `#/site/{id}` or `#/point/{lat},{lon}`, followed
 * by an optional `?t={ms}`. Anything that does not parse falls back to the globe.
 *
 * Units: latitude and longitude in degrees (longitude east-positive); time in UTC milliseconds
 * since 1970.
 */

/** The two overview scenes the top-bar toggle switches between. */
export type Overview = "globe" | "map";

export type Route =
  | { view: Overview; timeMs?: number }
  | { view: "site"; siteId: string; timeMs?: number }
  | { view: "point"; lat: number; lon: number; timeMs?: number };

/** Read a route from a location hash such as `#/site/shackleton_rim?t=1794787200000`. */
export function parseRoute(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const rawTime = new URLSearchParams(query).get("t");
  const parsedTime = rawTime === null || rawTime === "" ? NaN : Number(rawTime);
  const time = Number.isFinite(parsedTime) ? { timeMs: parsedTime } : {};
  const [head, rest] = path.split("/");

  if (head === "map") return { view: "map", ...time };
  if (head === "site" && rest) return { view: "site", siteId: decodeURIComponent(rest), ...time };
  if (head === "point" && rest) {
    const parts = rest.split(",");
    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    if (parts.length === 2 && parts[0] !== "" && parts[1] !== "" && Number.isFinite(lat) && Number.isFinite(lon)) {
      return { view: "point", lat, lon, ...time };
    }
  }
  return { view: "globe", ...time };
}

/** Write a route as a location hash. The inverse of `parseRoute`. */
export function formatRoute(route: Route): string {
  const time = route.timeMs === undefined ? "" : `?t=${Math.round(route.timeMs)}`;
  if (route.view === "site") return `#/site/${encodeURIComponent(route.siteId)}${time}`;
  if (route.view === "point") return `#/point/${route.lat},${route.lon}${time}`;
  return `#/${route.view}${time}`;
}
