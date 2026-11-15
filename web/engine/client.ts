import type { DataBundle } from "./runtime-types";
import type { Evaluation } from "./evaluate";

let worker: Worker | undefined;
let workerBundle: DataBundle | undefined;
let nextId = 1;
const pending = new Map<number, { resolve: (value: Evaluation) => void; reject: (reason: Error) => void }>();

/** The one long-lived worker; the 2.8 MB timetable is copied to it once per bundle, not per request. */
function workerFor(bundle: DataBundle): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; result?: Evaluation; error?: string }>) => {
      const waiting = pending.get(event.data.id);
      if (!waiting) return;
      pending.delete(event.data.id);
      if (event.data.ok && event.data.result) waiting.resolve(event.data.result);
      else waiting.reject(new Error(event.data.error ?? "The worker failed"));
    };
    worker.onerror = (error) => {
      for (const waiting of pending.values()) waiting.reject(new Error(error.message));
      pending.clear();
    };
  }
  if (workerBundle !== bundle) {
    worker.postMessage({ type: "init", values: bundle.ephemeris.values, label: bundle.ephemeris.label });
    workerBundle = bundle;
  }
  return worker;
}

/**
 * Evaluate a site in the worker: directions and verdicts at `timeMs`, events and metrics over the
 * window. The eye height comes from the site's skyline record.
 */
export function evaluateInWorker(
  bundle: DataBundle,
  siteId: string,
  timeMs: number,
  startMs: number,
  endMs: number,
): Promise<Evaluation> {
  const site = bundle.sites.find((candidate) => candidate.id === siteId);
  const skyline = bundle.skylines.get(siteId);
  if (!site || !skyline) return Promise.reject(new Error(`No prepared skyline for site ${siteId}`));
  const target = workerFor(bundle);
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    target.postMessage({ type: "evaluate", id, skyline, site: { lat: site.lat, lon: site.lon }, timeMs, startMs, endMs });
  });
}
