import { evaluateSite } from "./evaluate";
import type { EphemerisLabel } from "./runtime-types";
import type { Skyline } from "./types";

/** Messages the worker accepts: the timetable once, then any number of evaluations. */
export type WorkerRequest =
  | { type: "init"; values: Float32Array; label: EphemerisLabel }
  | { type: "evaluate"; id: number; skyline: Skyline; site: { lat: number; lon: number }; timeMs: number; startMs: number; endMs: number };

let timetable: { values: Float32Array; label: EphemerisLabel } | undefined;

/** Evaluate one site, time and window away from the UI thread; errors are sent back, never swallowed. */
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === "init") {
    timetable = { values: request.values, label: request.label };
    return;
  }
  try {
    if (!timetable) throw new Error("The worker has no timetable yet");
    const result = evaluateSite(timetable.values, timetable.label, request.skyline, request.site, request.timeMs, request.startMs, request.endMs);
    self.postMessage({ id: request.id, ok: true, result });
  } catch (reason: unknown) {
    self.postMessage({ id: request.id, ok: false, error: reason instanceof Error ? reason.message : String(reason) });
  }
};
