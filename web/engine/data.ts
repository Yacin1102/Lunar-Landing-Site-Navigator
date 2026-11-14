import type { EphemerisLabel, DataBundle, ShadeGrid, TerrainPatch } from "./runtime-types";
import type { Manifest, SiteList, Skyline } from "./types";
import { getDataFolder } from "./runtime-types";

/** Fetch JSON and throw a useful error when a prepared file is unavailable. */
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Prepared data request failed (${response.status}): ${url}`);
  }
  return (await response.json()) as T;
}

/** Fetch binary data and throw a useful error when a prepared file is unavailable. */
async function fetchBinary(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Prepared binary request failed (${response.status}): ${url}`);
  }
  return response.arrayBuffer();
}

/** Decode a little-endian Float32 file using the count in its JSON label. */
function decodeFloat32(buffer: ArrayBuffer, count: number): Float32Array {
  const values = new Float32Array(buffer);
  if (values.length < count) {
    throw new Error(`Binary file is short: expected ${count} values, got ${values.length}`);
  }
  return values.slice(0, count);
}

/** Decode a little-endian Int16 file using the count in its JSON label. */
function decodeInt16(buffer: ArrayBuffer, count: number): Int16Array {
  const values = new Int16Array(buffer);
  if (values.length < count) {
    throw new Error(`Binary file is short: expected ${count} values, got ${values.length}`);
  }
  return values.slice(0, count);
}

/** Load every prepared product and keep binary decoding driven by labels rather than constants. */
export async function loadDataBundle(folder = getDataFolder()): Promise<DataBundle> {
  const base = folder.replace(/\/$/, "");
  const manifest = await fetchJson<Manifest>(`${base}/manifest.json`);
  const siteList = await fetchJson<SiteList>(`${base}/sites.json`);
  const sites = siteList.sites;
  const ephemerisLabel = await fetchJson<EphemerisLabel>(`${base}/ephem.json`);
  const ephemerisBinary = await fetchBinary(`${base}/ephem.bin`);
  const skylines = new Map<string, Skyline>();
  const terrain = new Map<string, TerrainPatch>();
  const shade = new Map<string, ShadeGrid>();
  const ephemeris = {
    label: ephemerisLabel,
    values: decodeFloat32(ephemerisBinary, ephemerisLabel.count * ephemerisLabel.columns.length),
  };

  await Promise.all(
    sites.map(async (site) => {
      if (site.has_terrain) {
        const label = await fetchJson<TerrainPatch["label"]>(`${base}/terrain/${site.id}.json`);
        const binary = await fetchBinary(`${base}/terrain/${site.id}.bin`);
        terrain.set(site.id, {
          label,
          values: decodeFloat32(binary, label.n * label.n),
        });
      }
      if (site.has_shade_grid) {
        const label = await fetchJson<ShadeGrid["label"]>(`${base}/shade/${site.id}.json`);
        const skyline = await fetchBinary(`${base}/shade/${site.id}_skyline.bin`);
        const normal = await fetchBinary(`${base}/shade/${site.id}_normal.bin`);
        shade.set(site.id, {
          label,
          skyline: decodeInt16(skyline, label.n * label.n * label.n_az),
          normal: decodeFloat32(normal, label.n * label.n * 3),
        });
      }
      const skyline = await fetchJson<Skyline>(`${base}/skylines/${site.id}.json`);
      skylines.set(site.id, skyline);
    }),
  );
  return { manifest, sites, ephemeris, skylines, terrain, shade };
}
