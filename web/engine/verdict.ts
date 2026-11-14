import type { Visibility } from "./types";

/** Keep the provisional three-way light definition in one replaceable module. */
export function provisionalVerdict(visibility: Visibility): Visibility["status"] {
  return visibility.status;
}
