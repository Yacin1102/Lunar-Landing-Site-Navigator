import type { Direction, Visibility } from "./runtime-types";
import type { Skyline } from "./types";
import { clamp, degToRad, radToDeg } from "./math";
import { discRadiusDeg, skylineAt } from "./astro";

/** Estimate how much of a body's circular disc clears the skyline with vertical strips. */
export function visibleDiscFraction(
  direction: Direction,
  body: "sun" | "earth",
  skyline: Skyline,
  samples = 64,
): number {
  const radius = discRadiusDeg(body, direction.distance_km);
  let visibleArea = 0;
  let discArea = 0;
  for (let index = 0; index < samples; index += 1) {
    const x = -1 + (index + 0.5) * 2 / samples;
    const halfHeight = Math.sqrt(Math.max(0, 1 - x * x));
    const azOffset = radToDeg(Math.atan2(x * Math.sin(degToRad(radius)), Math.cos(degToRad(direction.el_deg))));
    const localSkyline = skylineAt(skyline.skyline_deg, skyline.az_step_deg, direction.az_deg + azOffset);
    const lower = direction.el_deg - halfHeight * radius;
    const upper = direction.el_deg + halfHeight * radius;
    const stripVisible = clamp((upper - Math.max(lower, localSkyline)) / (upper - lower), 0, 1);
    const stripWeight = 2 * halfHeight;
    visibleArea += stripVisible * stripWeight;
    discArea += stripWeight;
  }
  return discArea === 0 ? 0 : clamp(visibleArea / discArea, 0, 1);
}

/** Classify a disc using its edge clearance and the skyline uncertainty bound. */
export function classifyVisibility(
  direction: Direction,
  body: "sun" | "earth",
  skyline: Skyline,
): Visibility {
  const radius = discRadiusDeg(body, direction.distance_km);
  const skylineElevation = skylineAt(skyline.skyline_deg, skyline.az_step_deg, direction.az_deg);
  const error = skylineAt(skyline.skyline_err_deg, skyline.az_step_deg, direction.az_deg);
  const centerClearance = direction.el_deg - skylineElevation;
  const upperEdgeClearance = direction.el_deg + radius - skylineElevation;
  const lowerEdgeClearance = direction.el_deg - radius - skylineElevation;
  const status = lowerEdgeClearance > error
    ? "visible"
    : upperEdgeClearance < -error
      ? "blocked"
      : "uncertain";
  return {
    fraction: visibleDiscFraction(direction, body, skyline),
    center_clearance_deg: centerClearance,
    upper_edge_clearance_deg: upperEdgeClearance,
    status,
  };
}
