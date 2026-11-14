import type { Direction, EphemerisLabel, EventSet, Skyline, Vector3 } from "./types";
import { directionsAt, discRadiusDeg, directionFromBody, interpolateBody, skylineAt } from "./astro";

/** Find all upper-disc horizon crossings by scanning ten-minute intervals and bisecting. */
export function findEvents(
  values: Float32Array,
  label: EphemerisLabel,
  skyline: Skyline,
  site: { lat: number; lon: number; elev_m: number; mast_m?: number },
  startMs: number,
  endMs: number,
): EventSet {
  const result: EventSet = { sunrise: [], sunset: [], earthrise: [], earthset: [] };
  const stepMs = 10 * 60 * 1000;
  const bodies: Array<{ name: "sun" | "earth"; rise: keyof EventSet; set: keyof EventSet; offset: 0 | 3 }> = [
    { name: "sun", rise: "sunrise", set: "sunset", offset: 0 },
    { name: "earth", rise: "earthrise", set: "earthset", offset: 3 },
  ];
  for (const body of bodies) {
    const clearance = (timeMs: number): number => {
      const direction = directionsAt(values, label, timeMs, site.lat, site.lon, site.elev_m, site.mast_m)[body.name];
      return direction.el_deg + discRadiusDeg(body.name, direction.distance_km)
        - skylineAt(skyline.skyline_deg, skyline.az_step_deg, direction.az_deg);
    };
    let previousTime = startMs;
    let previousValue = clearance(previousTime);
    for (let time = startMs + stepMs; time <= endMs; time += stepMs) {
      const currentValue = clearance(time);
      if ((previousValue < 0 && currentValue >= 0) || (previousValue >= 0 && currentValue < 0)) {
        let low = previousTime;
        let high = time;
        for (let iteration = 0; iteration < 40 && high - low > 1000; iteration += 1) {
          const middle = Math.floor((low + high) / 2);
          if (clearance(middle) === 0 || Math.sign(clearance(middle)) === Math.sign(previousValue)) {
            low = middle;
          } else {
            high = middle;
          }
        }
        const crossing = Math.round((low + high) / 2);
        result[currentValue >= 0 ? body.rise : body.set].push(crossing);
      }
      previousTime = time;
      previousValue = currentValue;
    }
  }
  return result;
}

/** Return the body's direction at a time for event and metric consumers. */
export function eventDirection(
  values: Float32Array,
  label: EphemerisLabel,
  timeMs: number,
  body: "sun" | "earth",
  site: { lat: number; lon: number; elev_m: number; mast_m?: number },
): Direction {
  return directionsAt(values, label, timeMs, site.lat, site.lon, site.elev_m, site.mast_m)[body];
}
