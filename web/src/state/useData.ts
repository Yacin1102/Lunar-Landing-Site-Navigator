import { useEffect, useState } from "react";
import { loadDataBundle } from "../../engine/data";
import type { DataBundle } from "../../engine/runtime-types";

/** What the shell knows about the prepared data: still loading, failed, or ready. */
export type DataState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; bundle: DataBundle };

/**
 * Load the engine's prepared files once, when the app starts.
 *
 * Uses the engine's `loadDataBundle`, which reads the manifest first and refuses unknown
 * versions and files whose size does not match their label. Any refusal ends up here as an
 * error message for the screen; nothing is shown from a folder that failed its checks.
 */
export function useData(): DataState {
  const [state, setState] = useState<DataState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadDataBundle().then(
      (bundle) => {
        if (!cancelled) setState({ status: "ready", bundle });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
