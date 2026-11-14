import type { Skyline } from "../engine/types";

/** Result returned when a custom-point skyline request succeeds or fails. */
export type SkylineRequestResult =
  | { ok: true; skyline: Skyline }
  | { ok: false; kind: "unreachable" | "request"; message: string };

/** Ask the optional Python API for a skyline and preserve a clear unreachable state. */
export async function fetchCustomSkyline(
  baseUrl: string,
  lat: number,
  lon: number,
  mastM = 2,
  signal?: AbortSignal,
): Promise<SkylineRequestResult> {
  const url = new URL("/api/skyline", baseUrl || window.location.origin);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("mast_m", String(mastM));
  try {
    const response = await fetch(url, { signal });
    const payload = (await response.json()) as { error?: { message?: string } } | Skyline;
    if (!response.ok) {
      return {
        ok: false,
        kind: "request",
        message: payload && "error" in payload && payload.error?.message
          ? payload.error.message
          : `The skyline service returned HTTP ${response.status}.`,
      };
    }
    return { ok: true, skyline: payload as Skyline };
  } catch (reason: unknown) {
    if (reason instanceof DOMException && reason.name === "AbortError") {
      return { ok: false, kind: "request", message: "The skyline request was cancelled." };
    }
    return {
      ok: false,
      kind: "unreachable",
      message: "Skyline service unreachable. Terrain not included; verdict unavailable.",
    };
  }
}
