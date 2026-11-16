import type { Site } from "../../engine/types";

/**
 * Group sites by their `category`, in the order the categories first appear in `sites.json`.
 *
 * The set of categories is not hard-coded (handoff rule 7): whatever values the file holds
 * become the groups.
 */
export function groupByCategory(sites: Site[]): { category: string; sites: Site[] }[] {
  const groups = new Map<string, Site[]>();
  for (const site of sites) {
    const group = groups.get(site.category);
    if (group) group.push(site);
    else groups.set(site.category, [site]);
  }
  return [...groups].map(([category, members]) => ({ category, sites: members }));
}

/** Plain-language headings for category ids whose raw form would not read well. */
const KNOWN_HEADINGS: Record<string, string> = { psr: "Permanently shadowed" };

/**
 * Turn a category id such as `high_illumination` into a heading: "High illumination".
 * Unknown ids still get a heading, made from the id itself.
 */
export function categoryHeading(category: string): string {
  if (KNOWN_HEADINGS[category]) return KNOWN_HEADINGS[category];
  const words = category.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Write a position for display: "89.4505° S, 137.1600° W".
 *
 * Input: latitude in degrees (-90 to 90) and longitude in degrees, east-positive (-180 to 180).
 * The hemisphere letter replaces the sign, so the reader never has to know the sign convention.
 */
export function formatLatLon(lat: number, lon: number, decimals = 4): string {
  const ns = lat < 0 ? "S" : "N";
  const ew = lon < 0 ? "W" : "E";
  return `${Math.abs(lat).toFixed(decimals)}° ${ns}, ${Math.abs(lon).toFixed(decimals)}° ${ew}`;
}
