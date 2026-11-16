// Checks the committed imagery in web/public/assets/ against its own record, assets.json:
// every file is present, unchanged and of the stated size, and each picture is what the app
// will assume it is (global maps 4096 x 2048, elevation really 16-bit and in lunar range, the
// Sun transparent outside its disc, the hillshade georeference consistent).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const OUT = resolve(__dirname, "../public/assets");

interface Asset {
  path: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  bits_per_channel: number;
  credit: string;
  source: { url: string; raw_sha256: string; downloaded_utc: string; last_modified_utc: string | null };
  encoding?: { metres_per_count: number; offset_m: number };
  image_time?: string | null;
  month?: number;
}

const manifest = JSON.parse(readFileSync(resolve(OUT, "assets.json"), "utf8")) as { version: number; assets: Asset[] };
const byPath = (path: string) => {
  const asset = manifest.assets.find((candidate) => candidate.path === path);
  if (!asset) throw new Error(`${path} is not listed in assets.json`);
  return asset;
};

describe("assets.json", () => {
  it("lists the Moon maps, the hillshade, the Sun and twelve Earth months", () => {
    expect(manifest.version).toBe(1);
    const expected = [
      "moon/lroc_color_4096.jpg",
      "moon/ldem_4096_uint16.png",
      "hillshade/south_pole_hillshade.png",
      "sun/sun_hmi_2048.png",
      ...Array.from({ length: 12 }, (_, index) => `earth/bmng_${String(index + 1).padStart(2, "0")}.jpg`),
    ];
    expect(manifest.assets.map((asset) => asset.path)).toEqual(expected);
  });

  it.each(manifest.assets.map((asset) => [asset.path, asset] as const))("%s matches its recorded size, checksum and dimensions", async (_path, asset) => {
    const path = resolve(OUT, asset.path);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBe(asset.bytes);
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(asset.sha256);
    const meta = await sharp(path, { limitInputPixels: false }).metadata();
    expect([meta.width, meta.height]).toEqual([asset.width, asset.height]);
  });

  it.each(manifest.assets.map((asset) => [asset.path, asset] as const))("%s records where it came from", (_path, asset) => {
    expect(asset.source.url).toMatch(/^https:\/\/[a-z.]+\.nasa\.gov\//);
    expect(asset.source.raw_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(asset.source.downloaded_utc))).toBe(false);
    expect(asset.credit.length).toBeGreaterThan(0);
  });
});

describe("global maps", () => {
  it("are 4096 x 2048", () => {
    for (const asset of manifest.assets.filter((candidate) => candidate.path.startsWith("moon/") || candidate.path.startsWith("earth/"))) {
      expect([asset.path, asset.width, asset.height]).toEqual([asset.path, 4096, 2048]);
    }
  });

  it("the Earth months are numbered 1 to 12 in file order", () => {
    const months = manifest.assets.filter((asset) => asset.path.startsWith("earth/")).map((asset) => asset.month);
    expect(months).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe("Moon elevation map", () => {
  it("is a real 16-bit image whose heights, decoded with the recorded formula, are lunar", async () => {
    const asset = byPath("moon/ldem_4096_uint16.png");
    expect(asset.bits_per_channel).toBe(16);
    expect(asset.encoding).toMatchObject({ metres_per_count: 0.5, offset_m: -10000 });
    const { data, info } = await sharp(resolve(OUT, asset.path)).toColourspace("grey16").raw({ depth: "ushort" }).toBuffer({ resolveWithObject: true });
    expect([info.width, info.height, info.channels]).toEqual([4096, 2048, 1]);
    const counts = new Uint16Array(data.buffer, data.byteOffset, data.length / 2);
    const heightAt = (lat: number, lon: number) => {
      const column = Math.floor(((lon + 180) / 360) * info.width);
      const row = Math.floor(((90 - lat) / 180) * info.height);
      return counts[row * info.width + column] * asset.encoding!.metres_per_count + asset.encoding!.offset_m;
    };
    let lowest = Infinity;
    let highest = -Infinity;
    for (const count of counts) {
      const height = count * 0.5 - 10000;
      if (height < lowest) lowest = height;
      if (height > highest) highest = height;
    }
    // The Moon's surface spans about -9.1 km to +10.8 km relative to the 1737.4 km sphere.
    expect(lowest).toBeGreaterThan(-9300);
    expect(lowest).toBeLessThan(-8000);
    expect(highest).toBeLessThan(10900);
    expect(highest).toBeGreaterThan(9500);
    // Orientation: a deep basin, a far-side highland and a mare are where they should be.
    expect(heightAt(-55, -170)).toBeLessThan(-5000); // South Pole-Aitken basin floor
    expect(heightAt(5, -158)).toBeGreaterThan(5000); // far-side highlands
    expect(heightAt(35, -15)).toBeLessThan(-1500); // Mare Imbrium
    expect(heightAt(35, -15)).toBeGreaterThan(-3500);
  });

  it("agrees with the engine's own ground heights at broad features", async () => {
    const asset = byPath("moon/ldem_4096_uint16.png");
    const { data, info } = await sharp(resolve(OUT, asset.path)).toColourspace("grey16").raw({ depth: "ushort" }).toBuffer({ resolveWithObject: true });
    const counts = new Uint16Array(data.buffer, data.byteOffset, data.length / 2);
    // A crater floor is flat over several kilometres, so a 2.7 km map pixel can be compared
    // with the engine's point value there. Peaks and rims are too sharp for this map.
    for (const id of ["shackleton_floor", "haworth_floor", "faustini_floor"]) {
      const skyline = JSON.parse(readFileSync(resolve(OUT, `../data/skylines/${id}.json`), "utf8")) as { lat: number; lon: number; elev_m: number };
      const column = Math.floor(((skyline.lon + 180) / 360) * info.width);
      const row = Math.min(info.height - 1, Math.floor(((90 - skyline.lat) / 180) * info.height));
      const height = counts[row * info.width + column] * 0.5 - 10000;
      expect(Math.abs(height - skyline.elev_m), `${id}: map ${height} m, engine ${skyline.elev_m} m`).toBeLessThan(400);
    }
  });
});

describe("Sun disc", () => {
  it("is square, transparent in the corners, opaque at the centre and on the limb", async () => {
    const asset = byPath("sun/sun_hmi_2048.png");
    expect(asset.width).toBe(asset.height);
    expect(asset.image_time).toMatch(/^\d{4}\.\d{2}\.\d{2}_\d{2}:\d{2}:\d{2}_TAI$/);
    const { data, info } = await sharp(resolve(OUT, asset.path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return { value: data[offset], alpha: data[offset + info.channels - 1] };
    };
    const middle = Math.floor(info.width / 2);
    expect(pixel(0, 0).alpha).toBe(0);
    expect(pixel(info.width - 1, info.height - 1).alpha).toBe(0);
    expect(pixel(middle, middle).alpha).toBe(255);
    expect(pixel(3, middle).alpha).toBe(255);
    // Limb darkening is real in this product: the edge is clearly dimmer than the centre.
    expect(pixel(3, middle).value).toBeLessThan(pixel(middle, middle).value * 0.75);
    expect(pixel(3, middle).value).toBeGreaterThan(20);
  });
});

describe("south pole hillshade", () => {
  const sidecar = JSON.parse(readFileSync(resolve(OUT, "hillshade/south_pole_hillshade.json"), "utf8")) as Record<string, number | string>;

  it("has a georeference that agrees with the picture", () => {
    const asset = byPath("hillshade/south_pole_hillshade.png");
    expect([sidecar.width, sidecar.height]).toEqual([asset.width, asset.height]);
    expect(sidecar.projection).toBe("south polar stereographic");
    expect([sidecar.lat_origin_deg, sidecar.lon_origin_deg, sidecar.scale_at_origin]).toEqual([-90, 0, 1]);
    expect(sidecar.sphere_radius_m).toBe(1737400);
    const mpp = sidecar.metres_per_pixel as number;
    expect((sidecar.x_max_m as number) - (sidecar.x_min_m as number)).toBeCloseTo(mpp * asset.width, 6);
    expect((sidecar.y_max_m as number) - (sidecar.y_min_m as number)).toBeCloseTo(mpp * asset.height, 6);
    // The pole is the centre of the picture.
    expect((sidecar.x_min_m as number) + (sidecar.x_max_m as number)).toBeCloseTo(0, 6);
    expect((sidecar.y_min_m as number) + (sidecar.y_max_m as number)).toBeCloseTo(0, 6);
  });

  it("reaches latitude 80 south at the middle of each edge", () => {
    // Polar stereographic on a sphere, true scale at the pole: distance = 2 R tan((90 - |lat|) / 2).
    const radius = sidecar.sphere_radius_m as number;
    const edge = sidecar.x_max_m as number;
    const colatitude = 2 * Math.atan(edge / (2 * radius)) * (180 / Math.PI);
    expect(90 - colatitude).toBeCloseTo(80, 1);
  });
});

describe("repository hygiene", () => {
  it("credits every source in CREDITS.md", () => {
    const credits = readFileSync(resolve(OUT, "CREDITS.md"), "utf8");
    for (const phrase of [
      "NASA's Scientific Visualization Studio",
      "CGI Moon Kit",
      "LRO/LOLA",
      "PGDA",
      "Courtesy of NASA/SDO and the AIA, EVE, and HMI science teams.",
      "NASA Earth Observatory",
    ]) {
      expect(credits).toContain(phrase);
    }
    expect(credits).toContain(byPath("sun/sun_hmi_2048.png").source.downloaded_utc.slice(0, 10));
  });

  it("keeps raw downloads out of git", () => {
    const ignored = execFileSync("git", ["check-ignore", "assets-raw/moon/ldem_16_uint.tif"], { cwd: resolve(__dirname, ".."), encoding: "utf8" });
    expect(ignored.trim()).toBe("assets-raw/moon/ldem_16_uint.tif");
  });
});
