import type { DataBundle } from "./types";

/** Send a browser calculation to the worker and resolve its typed result. */
export function evaluateInWorker(
  bundle: DataBundle,
  siteId: string,
  timeMs: number,
  startMs: number,
  endMs: number,
): Promise<unknown> {
  const site = bundle.sites.find((candidate) => candidate.id === siteId);
  const skyline = bundle.skylines.get(siteId);
  if (!site || !skyline) return Promise.reject(new Error(`No prepared skyline for site ${siteId}`));
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ id: number; [key: string]: unknown }>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (error) => {
      worker.terminate();
      reject(error);
    };
    worker.postMessage({
      id: 1,
      type: "evaluate",
      values: bundle.ephemeris.values,
      label: bundle.ephemeris.label,
      skyline,
      site,
      timeMs,
      startMs,
      endMs,
    });
  });
}
