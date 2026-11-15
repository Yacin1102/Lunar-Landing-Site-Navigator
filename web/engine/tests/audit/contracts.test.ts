// Audit: the files the Python engine wrote, as the web app reads them. Every JSON file in
// web/public/data/ and web/public/data-mock/ is validated against docs/schemas/ with an
// independent validator (ajv); then the app's own loader reads both folders from disk, and the
// browser evaluation runs on every real site.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDataBundle } from "../../data";
import { evaluateSite } from "../../evaluate";
import { timetableSpan } from "../../astro";
import { REPO, readJson } from "./helpers";

const SCHEMAS = resolve(REPO, "docs/schemas");
const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const file of readdirSync(SCHEMAS)) ajv.addSchema(readJson(`docs/schemas/${file}`), file.replace(".schema.json", ""));

/** The contract of a JSON file, from where it sits in the folder. */
function contractOf(path: string): string {
  if (path === "manifest.json") return "manifest";
  if (path === "sites.json") return "sites";
  if (path === "ephem.json") return "ephem";
  return path.split("/")[0].replace(/s$/, "").replace("skyline", "skyline");
}

function jsonFiles(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".json")) out.push(relative(folder, path).replaceAll("\\", "/"));
    }
  };
  walk(folder);
  return out;
}

/** Serve a folder on disk through `fetch`, as the dev server would. */
function serveFolder(prefix: string, folder: string): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input).slice(prefix.length + 1);
    try {
      const bytes = readFileSync(resolve(folder, path));
      return new Response(bytes, { status: 200 });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

afterEach(() => vi.unstubAllGlobals());

describe.each([["real", "web/public/data"], ["mock", "web/public/data-mock"]])("%s data folder", (kind, folder) => {
  const root = resolve(REPO, folder);

  it("every JSON file passes its schema in docs/schemas/", () => {
    const files = jsonFiles(root);
    expect(files.length).toBeGreaterThan(10);
    for (const path of files) {
      const contract = contractOf(path);
      const validate = ajv.getSchema(contract);
      expect(validate, `no schema for ${path}`).toBeDefined();
      const ok = validate!(JSON.parse(readFileSync(resolve(root, path), "utf8")));
      expect(ok, `${path}: ${ajv.errorsText(validate!.errors)}`).toBe(true);
    }
    console.log(`${folder}: ${files.length} JSON files pass their schemas`);
  });

  it("is read by the app's loader: versions, sizes from labels, manifest bytes, rows north to south", async () => {
    serveFolder("/x", root);
    const bundle = await loadDataBundle("/x");
    expect(bundle.manifest.data_kind).toBe(kind);
    expect(bundle.sites.length).toBe(10);
    for (const site of bundle.sites) {
      const sky = bundle.skylines.get(site.id)!;
      expect(sky.skyline_deg.length).toBe(Math.round(360 / sky.az_step_deg));
      expect(sky.lat).toBe(site.lat);
      expect(sky.lon).toBe(site.lon);
      const manifestSite = bundle.manifest.sites.find((s) => s.id === site.id)!;
      expect([manifestSite.has_terrain, manifestSite.has_shade_grid]).toEqual([site.has_terrain, site.has_shade_grid]);
      const terrain = bundle.terrain.get(site.id);
      if (terrain) {
        const n = terrain.label.n;
        expect(terrain.values.length).toBe(n * n);
        expect(terrain.values[((n - 1) / 2) * n + (n - 1) / 2]).toBeCloseTo(0, 3); // the site is the centre sample
      }
      const shade = bundle.shade.get(site.id);
      if (shade) {
        const { n, n_az } = shade.label;
        expect(shade.skyline.length).toBe(n * n * n_az);
        for (let cell = 0; cell < n * n; cell += 1) {
          const [e, nn, u] = [shade.normal[3 * cell], shade.normal[3 * cell + 1], shade.normal[3 * cell + 2]];
          expect(Math.hypot(e, nn, u)).toBeCloseTo(1, 4);
          expect(u).toBeGreaterThan(0); // normals point up
        }
      }
    }
  });

  it("refuses a binary file whose size disagrees with its label", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = String(input).slice(3);
      const bytes = readFileSync(resolve(root, path));
      return new Response(path === "ephem.bin" ? bytes.subarray(0, bytes.length - 24) : bytes, { status: 200 });
    });
    await expect(loadDataBundle("/x")).rejects.toThrow(/ephem\.bin/);
  });
});

describe("the browser evaluation on every real site", () => {
  it("gives finite directions, a valid verdict and sane metrics for each site", async () => {
    const root = resolve(REPO, "web/public/data");
    serveFolder("/x", root);
    const bundle = await loadDataBundle("/x");
    const { values, label } = bundle.ephemeris;
    const t = timetableSpan(label).startMs + 30 * 86400000;
    for (const site of bundle.sites) {
      const sky = bundle.skylines.get(site.id)!;
      const r = evaluateSite(values, label, sky, site, t, t - 2 * 86400000, t + 5 * 86400000);
      for (const d of [r.directions.sun, r.directions.earth]) expect(Number.isFinite(d.az_deg + d.el_deg + d.distance_km), site.id).toBe(true);
      expect(["visible", "blocked", "uncertain"]).toContain(r.sunVisibility.status);
      expect(r.metrics.sunlight_hours).toBeGreaterThanOrEqual(0);
      expect(r.metrics.sunlight_hours + r.metrics.uncertain_sun_hours).toBeLessThanOrEqual(7 * 24 + 1e-9);
      if (r.metrics.time_to_next_sunset_ms !== undefined) expect(r.metrics.time_to_next_sunset_ms).toBeGreaterThanOrEqual(0);
    }
    // The permanently shadowed floors in the list must never be lit in this week.
    for (const id of ["shackleton_floor", "haworth_floor", "faustini_floor", "cabeus_lcross"]) {
      const site = bundle.sites.find((s) => s.id === id)!;
      const r = evaluateSite(values, label, bundle.skylines.get(id)!, site, t, t - 2 * 86400000, t + 5 * 86400000);
      expect(r.metrics.sunlight_hours, id).toBe(0);
    }
  }, 120_000);
});
