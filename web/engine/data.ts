import type { EphemerisLabel, DataBundle, ShadeGrid, TerrainPatch } from "./runtime-types";
import type { Manifest, SiteList, Skyline } from "./types";
import { getDataFolder } from "./runtime-types";

/** The only `version` of every JSON contract this app understands. */
export const KNOWN_VERSION = 1;

/** True when this machine stores numbers little-endian, as the binary contracts do. */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Fetch JSON, refusing a missing file or a `version` this app does not know. */
async function fetchJson<T extends { version: number }>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Prepared data request failed (${response.status}): ${url}`);
  }
  const document = (await response.json()) as T;
  if (document.version !== KNOWN_VERSION) {
    throw new Error(`Unknown version ${String(document.version)} in ${url}; this app reads version ${KNOWN_VERSION}`);
  }
  return document;
}

/** Fetch binary data and throw a useful error when a prepared file is unavailable. */
async function fetchBinary(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Prepared binary request failed (${response.status}): ${url}`);
  }
  return response.arrayBuffer();
}

/** Refuse a binary file whose size is not exactly what its label says. */
function checkSize(buffer: ArrayBuffer, count: number, bytesPerValue: number, url: string): void {
  if (buffer.byteLength !== count * bytesPerValue) {
    throw new Error(`${url} has ${buffer.byteLength} bytes; its label says ${count} values of ${bytesPerValue} bytes (${count * bytesPerValue})`);
  }
}

/** Decode a little-endian Float32 file, refusing any size other than the label's count. */
export function decodeFloat32(buffer: ArrayBuffer, count: number, url = "binary file"): Float32Array {
  checkSize(buffer, count, 4, url);
  if (LITTLE_ENDIAN) return new Float32Array(buffer);
  const view = new DataView(buffer);
  return Float32Array.from({ length: count }, (_, i) => view.getFloat32(4 * i, true));
}

/** Decode a little-endian Int16 file, refusing any size other than the label's count. */
export function decodeInt16(buffer: ArrayBuffer, count: number, url = "binary file"): Int16Array {
  checkSize(buffer, count, 2, url);
  if (LITTLE_ENDIAN) return new Int16Array(buffer);
  const view = new DataView(buffer);
  return Int16Array.from({ length: count }, (_, i) => view.getInt16(2 * i, true));
}

/** The timetable columns in the order `astro.ts` reads them: the Sun at offset 0, the Earth at 3. */
export const EPHEMERIS_COLUMNS = ["sun_x", "sun_y", "sun_z", "earth_x", "earth_y", "earth_z"] as const;

/**
 * Refuse a timetable label the engine would misread (Contract 1). The engine reads each row by
 * position, so the columns must be exactly `EPHEMERIS_COLUMNS` in that order, in km, in the
 * `MOON_ME` frame, from the Moon's centre. Anything else is an error, not a guess.
 */
export function checkEphemerisLabel(label: EphemerisLabel, url = "ephem.json"): void {
  const columns = label.columns as readonly string[];
  if (columns.length !== EPHEMERIS_COLUMNS.length || columns.some((c, i) => c !== EPHEMERIS_COLUMNS[i])) {
    throw new Error(`${url}: columns must be ${EPHEMERIS_COLUMNS.join(", ")} in that order, not ${columns.join(", ")}`);
  }
  if (label.units !== "km") throw new Error(`${url}: units must be km, not ${String(label.units)}`);
  if (label.frame !== "MOON_ME") throw new Error(`${url}: frame must be MOON_ME, not ${String(label.frame)}`);
  if (label.origin !== "MOON") throw new Error(`${url}: origin must be MOON, not ${String(label.origin)}`);
}

/** Refuse a skyline whose arrays do not have one entry per wedge of 360 / az_step_deg. */
function checkSkyline(skyline: Skyline, url: string): void {
  const entries = Math.round(360 / skyline.az_step_deg);
  if (skyline.skyline_deg.length !== entries || skyline.skyline_err_deg.length !== entries) {
    throw new Error(`${url}: expected ${entries} entries for a ${skyline.az_step_deg} degree step`);
  }
}

/**
 * A binary fetcher that also checks each file against the manifest: it must be listed, and its
 * size must equal the manifest's `bytes`.
 */
function listedFetcher(base: string, manifest: Manifest): (path: string) => Promise<ArrayBuffer> {
  const bytes = new Map(manifest.files.map((file) => [file.path, file.bytes]));
  return async (path: string) => {
    const url = `${base}/${path}`;
    const buffer = await fetchBinary(url);
    const listed = bytes.get(path);
    if (listed === undefined) throw new Error(`${url} is not listed in manifest.json`);
    if (listed !== buffer.byteLength) throw new Error(`${url} has ${buffer.byteLength} bytes; manifest.json says ${listed}`);
    return buffer;
  };
}

/** Load every prepared product and keep binary decoding driven by labels rather than constants. */
export async function loadDataBundle(folder = getDataFolder()): Promise<DataBundle> {
  const base = folder.replace(/\/$/, "");
  const manifest = await fetchJson<Manifest>(`${base}/manifest.json`);
  const siteList = await fetchJson<SiteList>(`${base}/sites.json`);
  const sites = siteList.sites;
  const ephemerisLabel = await fetchJson<EphemerisLabel>(`${base}/ephem.json`);
  checkEphemerisLabel(ephemerisLabel, `${base}/ephem.json`);
  const fetchListed = listedFetcher(base, manifest);
  const ephemerisBinary = await fetchListed("ephem.bin");
  const skylines = new Map<string, Skyline>();
  const terrain = new Map<string, TerrainPatch>();
  const shade = new Map<string, ShadeGrid>();
  const ephemeris = {
    label: ephemerisLabel,
    values: decodeFloat32(ephemerisBinary, ephemerisLabel.count * ephemerisLabel.columns.length, `${base}/ephem.bin`),
  };

  await Promise.all(
    sites.map(async (site) => {
      if (site.has_terrain) {
        const label = await fetchJson<TerrainPatch["label"]>(`${base}/terrain/${site.id}.json`);
        const binary = await fetchListed(`terrain/${site.id}.bin`);
        terrain.set(site.id, {
          label,
          values: decodeFloat32(binary, label.n * label.n, `${base}/terrain/${site.id}.bin`),
        });
      }
      if (site.has_shade_grid) {
        const label = await fetchJson<ShadeGrid["label"]>(`${base}/shade/${site.id}.json`);
        const skyline = await fetchListed(`shade/${site.id}_skyline.bin`);
        const normal = await fetchListed(`shade/${site.id}_normal.bin`);
        shade.set(site.id, {
          label,
          skyline: decodeInt16(skyline, label.n * label.n * label.n_az, `${base}/shade/${site.id}_skyline.bin`),
          normal: decodeFloat32(normal, label.n * label.n * 3, `${base}/shade/${site.id}_normal.bin`),
        });
      }
      const skyline = await fetchJson<Skyline>(`${base}/skylines/${site.id}.json`);
      checkSkyline(skyline, `${base}/skylines/${site.id}.json`);
      skylines.set(site.id, skyline);
    }),
  );
  return { manifest, sites, ephemeris, skylines, terrain, shade };
}
