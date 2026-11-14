import { calculateMetrics } from "./metrics";
import { directionsAt } from "./astro";
import { findEvents } from "./events";
import { classifyVisibility } from "./visibility";
import type { EphemerisLabel, Skyline } from "./types";

type WorkerRequest = {
  id: number;
  type: "evaluate";
  values: Float32Array;
  label: EphemerisLabel;
  skyline: Skyline;
  site: { lat: number; lon: number; elev_m: number; mast_m?: number };
  timeMs: number;
  startMs: number;
  endMs: number;
};

/** Evaluate one time and event window inside a dedicated browser worker. */
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type !== "evaluate") return;
  const directions = directionsAt(
    request.values,
    request.label,
    request.timeMs,
    request.site.lat,
    request.site.lon,
    request.site.elev_m,
    request.site.mast_m,
  );
  const sunVisibility = classifyVisibility(directions.sun, "sun", request.skyline);
  const earthVisibility = classifyVisibility(directions.earth, "earth", request.skyline);
  const events = findEvents(request.values, request.label, request.skyline, request.site, request.startMs, request.endMs);
  const metrics = calculateMetrics(
    events,
    request.startMs,
    request.endMs,
    (time) => classifyVisibility(
      directionsAt(request.values, request.label, time, request.site.lat, request.site.lon, request.site.elev_m, request.site.mast_m).sun,
      "sun",
      request.skyline,
    ).status === "visible",
    (time) => classifyVisibility(
      directionsAt(request.values, request.label, time, request.site.lat, request.site.lon, request.site.elev_m, request.site.mast_m).earth,
      "earth",
      request.skyline,
    ).status === "visible",
  );
  self.postMessage({ id: request.id, directions, sunVisibility, earthVisibility, events, metrics });
};
