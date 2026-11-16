/**
 * fetch-assets: download the NASA imagery once and convert it to web sizes.
 *
 * Role: the only place the app's pictures come from. It downloads each source file to
 * `web/assets-raw/` (ignored by git), converts it, writes the result to `web/public/assets/`
 * (committed) and records every file in `web/public/assets/assets.json`: source URL, the
 * server's Last-Modified date, the download date, sizes and SHA-256 of both the raw and the
 * processed file. The app never hot-links; it reads only the processed files.
 *
 * How it works: each asset is a small recipe (download, convert, describe). An asset whose
 * output already exists and is listed in assets.json is skipped, so running the script again
 * changes nothing. This matters for the Sun: its source URL is "latest" and changes every day,
 * so it is downloaded once and never refreshed unless asked.
 *
 * Usage (from web/):
 *   node scripts/fetch-assets.mjs            make whatever is missing
 *   node scripts/fetch-assets.mjs --force    rebuild every output from the raw downloads
 *   node scripts/fetch-assets.mjs --force --refresh   download everything again as well
 *
 * Units and conventions written into the sidecars: degrees, metres, longitude east-positive,
 * rows north to south, columns west to east (the repository's shared rules).
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { fromFile } from "geotiff";
import sharp from "sharp";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = resolve(WEB, "assets-raw");
const OUT = resolve(WEB, "public/assets");
const MANIFEST = resolve(OUT, "assets.json");
const FORCE = process.argv.includes("--force");
const REFRESH = process.argv.includes("--refresh");

/** Global maps are stored at this size: 4096 x 2048, 11.4 pixels per degree. */
const GLOBAL_WIDTH = 4096;
const GLOBAL_HEIGHT = 2048;

const SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720";
const BMNG = "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry";
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * The observation time printed in the corner of a downloaded Sun image, read by eye and keyed
 * to that raw file's SHA-256. The script cannot read the caption itself; a new download has a
 * new checksum and gets `null` until its caption is added here.
 */
const SUN_CAPTIONS = {
  "eb4c42dad26921f8e3547c17b3b15f6e9ce12a4697b78498107c4e6c27fc56b2": "2026.11.16_00:23:15_TAI",
};

sharp.cache(false);

/** SHA-256 of a file, as lowercase hex. */
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Download `url` to `web/assets-raw/{name}` unless it is already there.
 * Returns what is known about the raw file. The download goes to a `.part` file first, so an
 * interrupted run never leaves a half file under the final name.
 */
async function download(url, name) {
  const path = resolve(RAW, name);
  const notePath = `${path}.source.json`;
  if (existsSync(path) && existsSync(notePath) && !REFRESH) return { path, ...JSON.parse(readFileSync(notePath, "utf8")) };

  mkdirSync(dirname(path), { recursive: true });
  process.stdout.write(`  downloading ${url}\n`);
  const response = await fetch(url, { headers: { "User-Agent": "fetch-assets/1.0" } });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${path}.part`));
  const expected = Number(response.headers.get("content-length"));
  const bytes = statSync(`${path}.part`).size;
  if (Number.isFinite(expected) && expected > 0 && bytes !== expected) throw new Error(`${url}: got ${bytes} bytes, server said ${expected}`);
  renameSync(`${path}.part`, path);

  const lastModified = response.headers.get("last-modified");
  const note = {
    url,
    raw_bytes: bytes,
    raw_sha256: sha256(path),
    last_modified_utc: lastModified ? new Date(lastModified).toISOString() : null,
    downloaded_utc: new Date().toISOString(),
  };
  writeFileSync(notePath, `${JSON.stringify(note, null, 2)}\n`);
  return { path, ...note };
}

/** Describe a processed file for assets.json: path, size, checksum and pixel dimensions. */
async function describe(relativePath) {
  const path = resolve(OUT, relativePath);
  const meta = await sharp(path, { limitInputPixels: false }).metadata();
  return {
    path: relativePath,
    bytes: statSync(path).size,
    sha256: sha256(path),
    width: meta.width,
    height: meta.height,
    bits_per_channel: meta.depth === "ushort" ? 16 : 8,
    channels: meta.channels,
  };
}

/** Strip the local path from a download record before it goes into assets.json. */
function sourceOf(raw) {
  const { path: _path, ...source } = raw;
  return source;
}

/** The layout shared by every global map here: plain latitude/longitude, 0 degrees in the middle. */
const GLOBAL_LAYOUT = {
  projection: "equirectangular",
  lon_west_deg: -180,
  lon_east_deg: 180,
  lat_north_deg: 90,
  lat_south_deg: -90,
  rows: "north to south",
  columns: "west to east",
};

/** Moon colour: LROC WAC mosaic from the SVS CGI Moon Kit, 8192 x 4096 TIFF to 4096 x 2048 JPEG. */
async function moonColour() {
  const raw = await download(`${SVS}/lroc_color_poles_8k.tif`, "moon/lroc_color_poles_8k.tif");
  const out = "moon/lroc_color_4096.jpg";
  await sharp(raw.path, { limitInputPixels: false })
    .resize(GLOBAL_WIDTH, GLOBAL_HEIGHT, { kernel: "lanczos3" })
    .jpeg({ quality: 88, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toFile(resolve(OUT, out));
  return {
    ...(await describe(out)),
    what: "Moon colour map (LROC WAC mosaic with polar fill), NASA SVS CGI Moon Kit",
    credit: "NASA's Scientific Visualization Studio",
    frame: "MOON_ME",
    layout: GLOBAL_LAYOUT,
    source: sourceOf(raw),
  };
}

/**
 * Moon elevation: LOLA heights from the SVS CGI Moon Kit, 5760 x 2880 16-bit TIFF to a
 * 4096 x 2048 16-bit greyscale PNG.
 *
 * The SVS page states the encoding: unsigned 16-bit half-metres relative to a radius of
 * 1,727,400 m (the LOLA values offset by +20,000 counts). So
 *   height above the 1737.4 km sphere, metres = count * 0.5 - 10000.
 * Resizing uses a linear kernel: it averages neighbours and cannot overshoot, so every output
 * value lies between real input values and keeps the same units.
 */
async function moonElevation() {
  const raw = await download(`${SVS}/ldem_16_uint.tif`, "moon/ldem_16_uint.tif");
  const out = "moon/ldem_4096_uint16.png";
  await sharp(raw.path, { limitInputPixels: false })
    .resize(GLOBAL_WIDTH, GLOBAL_HEIGHT, { kernel: "linear" })
    .toColourspace("grey16")
    .png({ compressionLevel: 9 })
    .toFile(resolve(OUT, out));
  return {
    ...(await describe(out)),
    what: "Moon elevation map (LOLA gridded heights), NASA SVS CGI Moon Kit",
    credit: "NASA's Scientific Visualization Studio; LRO/LOLA",
    frame: "MOON_ME",
    layout: GLOBAL_LAYOUT,
    encoding: {
      metres_per_count: 0.5,
      offset_m: -10000,
      reference_radius_m: 1737400,
      formula: "height_m above the 1737.4 km sphere = count * 0.5 - 10000",
      stated_by: "https://svs.gsfc.nasa.gov/4720/",
    },
    source: sourceOf(raw),
  };
}

/**
 * South pole hillshade: PGDA LOLA product 90 (Barker et al. 2023), 80 m per pixel, to a
 * half-resolution 8-bit PNG plus a JSON sidecar with the georeference.
 *
 * Nothing about the projection is typed in: pixel size, corner coordinates and the projection
 * keys are read from the GeoTIFF's own tags, and the sidecar is derived from them. The
 * reduction factor is an exact integer, so the output pixel grid stays aligned with the source.
 */
async function hillshade() {
  const REDUCE = 2;
  const raw = await download("https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_80MPP_ADJ_HILL.TIF", "hillshade/LDEM_80S_80MPP_ADJ_HILL.TIF");
  const tiff = await fromFile(raw.path);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const [resX, resY] = image.getResolution();
  const [xMin, yMin, xMax, yMax] = image.getBoundingBox();
  const keys = image.getGeoKeys();
  await tiff.close();
  if (width % REDUCE !== 0 || height % REDUCE !== 0) throw new Error(`hillshade ${width} x ${height} is not divisible by ${REDUCE}`);
  if (Math.abs(Math.abs(resX) - Math.abs(resY)) > 1e-9) throw new Error("hillshade pixels are not square");

  const out = "hillshade/south_pole_hillshade.png";
  await sharp(raw.path, { limitInputPixels: false })
    .resize(width / REDUCE, height / REDUCE, { kernel: "lanczos3" })
    .toColourspace("b-w")
    .png({ compressionLevel: 9 })
    .toFile(resolve(OUT, out));

  const described = await describe(out);
  const sidecar = {
    version: 1,
    image: out.split("/").pop(),
    width: described.width,
    height: described.height,
    projection: "south polar stereographic",
    lat_origin_deg: keys.ProjNatOriginLatGeoKey ?? null,
    lon_origin_deg: keys.ProjStraightVertPoleLongGeoKey ?? keys.ProjNatOriginLongGeoKey ?? null,
    scale_at_origin: keys.ProjScaleAtNatOriginGeoKey ?? null,
    false_easting_m: keys.ProjFalseEastingGeoKey ?? null,
    false_northing_m: keys.ProjFalseNorthingGeoKey ?? null,
    sphere_radius_m: keys.GeogSemiMajorAxisGeoKey ?? null,
    metres_per_pixel: Math.abs(resX) * REDUCE,
    x_min_m: xMin,
    x_max_m: xMax,
    y_min_m: yMin,
    y_max_m: yMax,
    pixel_to_map: "x_m = x_min_m + (column + 0.5) * metres_per_pixel; y_m = y_max_m - (row + 0.5) * metres_per_pixel",
    source_metres_per_pixel: Math.abs(resX),
    source_width: width,
    source_height: height,
    source_geokeys: keys,
  };
  writeFileSync(resolve(OUT, "hillshade/south_pole_hillshade.json"), `${JSON.stringify(sidecar, null, 2)}\n`);
  return {
    ...described,
    what: "South polar hillshade to 80 degrees south, LOLA (PGDA product 90, Barker et al. 2023)",
    credit: "NASA/GSFC LRO/LOLA, Planetary Geodesy Data Archive (PGDA)",
    sidecar: "hillshade/south_pole_hillshade.json",
    source: sourceOf(raw),
  };
}

/**
 * Sun: one SDO/HMI continuum image (plain HMII: white, with the real limb darkening), cropped
 * to the disc and made transparent outside it.
 *
 * The disc is found in the image itself. A pixel counts as "disc" when it is brighter than a
 * low threshold; the columns and rows that hold more than a handful of such pixels give the
 * disc's bounding box; the caption in the corner forms a separate short run and is left out. The crop is
 * that box, so the disc's edge touches the edge of the picture and the picture's width is the
 * Sun's diameter. Outside the fitted circle the alpha is 0, with a one-pixel soft edge.
 */
async function sun() {
  const raw = await download("https://sdo.gsfc.nasa.gov/assets/img/latest/latest_2048_HMII.jpg", "sun/latest_2048_HMII.jpg");
  const { data, info } = await sharp(raw.path).greyscale().raw().toBuffer({ resolveWithObject: true });
  const THRESHOLD = 20;
  const MIN_RUN = 40;
  const columns = new Uint32Array(info.width);
  const rows = new Uint32Array(info.height);
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[y * info.width + x] > THRESHOLD) {
        columns[x] += 1;
        rows[y] += 1;
      }
    }
  }
  // The disc is the longest unbroken run of busy columns (or rows). The caption under the disc
  // is a separate, much shorter run, so it is left out.
  const longestRun = (counts) => {
    let best = [0, -1];
    let start = -1;
    for (let i = 0; i <= counts.length; i += 1) {
      const busy = i < counts.length && counts[i] >= MIN_RUN;
      if (busy && start < 0) start = i;
      if (!busy && start >= 0) {
        if (i - 1 - start > best[1] - best[0]) best = [start, i - 1];
        start = -1;
      }
    }
    return best;
  };
  const [left, right] = longestRun(columns);
  const [top, bottom] = longestRun(rows);
  const diameterX = right - left + 1;
  const diameterY = bottom - top + 1;
  if (Math.abs(diameterX - diameterY) > 6) throw new Error(`Sun disc is not round: ${diameterX} x ${diameterY} pixels`);
  const size = Math.max(diameterX, diameterY);
  const centreX = (left + right + 1) / 2;
  const centreY = (top + bottom + 1) / 2;
  const cropLeft = Math.round(centreX - size / 2);
  const cropTop = Math.round(centreY - size / 2);
  const radius = size / 2;

  const mask = Buffer.alloc(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x + 0.5 - radius, y + 0.5 - radius);
      mask[y * size + x] = Math.round(255 * Math.min(1, Math.max(0, radius - distance)));
    }
  }
  const out = "sun/sun_hmi_2048.png";
  await sharp(raw.path)
    .extract({ left: cropLeft, top: cropTop, width: size, height: size })
    .removeAlpha()
    .joinChannel(mask, { raw: { width: size, height: size, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toFile(resolve(OUT, out));

  return {
    ...(await describe(out)),
    what: "The Sun's visible disc: SDO/HMI intensitygram (continuum), plain HMII product",
    credit: "Courtesy of NASA/SDO and the AIA, EVE, and HMI science teams.",
    image_time: SUN_CAPTIONS[raw.raw_sha256] ?? null,
    image_time_note: "The source URL is the 'latest' image. image_time is the caption printed in the downloaded picture, read by eye and keyed to the raw file's SHA-256; last_modified_utc is the server's time for that file.",
    disc: {
      note: "The picture is cropped to the disc: its width is the Sun's diameter and its centre is the Sun's centre.",
      diameter_px: size,
      source_centre_px: [centreX, centreY],
      source_size_px: [info.width, info.height],
    },
    source: sourceOf(raw),
  };
}

/** Earth: one Blue Marble Next Generation month (topography and bathymetry), 5400 x 2700 to 4096 x 2048. */
async function earth(monthIndex) {
  const mm = String(monthIndex + 1).padStart(2, "0");
  const file = `world.topo.bathy.2004${mm}.3x5400x2700.jpg`;
  const raw = await download(`${BMNG}/${MONTHS[monthIndex]}/${file}`, `earth/${file}`);
  const out = `earth/bmng_${mm}.jpg`;
  await sharp(raw.path, { limitInputPixels: false })
    .resize(GLOBAL_WIDTH, GLOBAL_HEIGHT, { kernel: "lanczos3" })
    .jpeg({ quality: 85, mozjpeg: true })
    .toFile(resolve(OUT, out));
  return {
    ...(await describe(out)),
    what: `Earth, ${MONTHS[monthIndex]}: Blue Marble Next Generation with topography and bathymetry (2004)`,
    credit: "NASA Earth Observatory (Blue Marble: Next Generation, Reto Stöckli)",
    month: monthIndex + 1,
    layout: GLOBAL_LAYOUT,
    source: sourceOf(raw),
  };
}

const RECIPES = [
  ["moon/lroc_color_4096.jpg", moonColour],
  ["moon/ldem_4096_uint16.png", moonElevation],
  ["hillshade/south_pole_hillshade.png", hillshade],
  ["sun/sun_hmi_2048.png", sun],
  ...MONTHS.map((_, index) => [`earth/bmng_${String(index + 1).padStart(2, "0")}.jpg`, () => earth(index)]),
];

const previous = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : { version: 1, assets: [] };
const assets = [];
for (const [path, recipe] of RECIPES) {
  const known = previous.assets.find((asset) => asset.path === path);
  if (known && existsSync(resolve(OUT, path)) && !FORCE) {
    process.stdout.write(`kept  ${path}\n`);
    assets.push(known);
    continue;
  }
  mkdirSync(dirname(resolve(OUT, path)), { recursive: true });
  process.stdout.write(`make  ${path}\n`);
  assets.push(await recipe());
}
writeFileSync(MANIFEST, `${JSON.stringify({ version: 1, assets }, null, 2)}\n`);
const total = assets.reduce((sum, asset) => sum + asset.bytes, 0);
process.stdout.write(`${assets.length} assets, ${(total / 1e6).toFixed(1)} MB, listed in public/assets/assets.json\n`);
