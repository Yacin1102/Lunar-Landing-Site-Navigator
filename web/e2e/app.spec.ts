// Browser tests of the whole app, run against the production build in both viewports.
// They save the screenshots in docs/screenshots/ and measure two things on real screen pixels:
// the share of the Sun's disc left visible by the terrain, and the Earth's sunlit fraction.
import { existsSync, readFileSync } from "node:fs";
import { decode } from "fast-png";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { directionsAt, interpolateBody, sitePosition } from "../engine/astro";
import { visibleDiscFraction } from "../engine/visibility";
import type { EphemerisLabel } from "../engine/runtime-types";
import type { Skyline } from "../engine/types";
import { earthPhaseAngleDeg, litFraction } from "../src/lib/geometry";

const json = <T,>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
const sites = json<{ sites: { id: string; name: string; lat: number; lon: number }[] }>("public/data/sites.json").sites;
const label = json<EphemerisLabel>("public/data/ephem.json");
const raw = readFileSync("public/data/ephem.bin");
const values = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const HOUR = 3_600_000;
const RIM = "shackleton_rim";
const rim = sites.find((site) => site.id === RIM)!;
const rimSkyline = json<Skyline>(`public/data/skylines/${RIM}.json`);

/** First time, scanning in 20-minute steps, when the terrain hides about half of the Sun at the rim site. */
function halfHiddenSunTime(): { timeMs: number; fraction: number } {
  for (let t = label.t0_ms + 2 * HOUR; t < label.t0_ms + 400 * 24 * HOUR; t += HOUR / 3) {
    const sun = directionsAt(values, label, t, rim.lat, rim.lon, rimSkyline.elev_m, rimSkyline.mast_m).sun;
    const fraction = visibleDiscFraction(sun, "sun", rimSkyline, 0);
    if (fraction > 0.35 && fraction < 0.65) return { timeMs: t, fraction };
  }
  throw new Error("no half-hidden Sun found in 400 days");
}

/** A custom point with the Earth well above the horizon, and a time when the Earth is about half lit. */
const POINT = { lat: -82, lon: 0 };
function halfLitEarthTime(): { timeMs: number; lit: number } {
  for (let t = label.t0_ms + 2 * HOUR; t < label.t0_ms + 60 * 24 * HOUR; t += HOUR) {
    const lit = litFraction(earthPhaseAngleDeg(interpolateBody(values, label, t, 0), interpolateBody(values, label, t, 3), sitePosition(POINT.lat, POINT.lon, 0)));
    if (lit > 0.3 && lit < 0.45) return { timeMs: t, lit };
  }
  throw new Error("no half-lit Earth found");
}

function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => errors.push(`request failed: ${request.url()}`));
  return errors;
}

const shot = (page: Page, name: string, project: string) => page.screenshot({ path: `../docs/screenshots/${name}-${project}.png` });

/** Share of the disc's ellipse covered by pixels brighter than `threshold` (0 to 255) on a canvas screenshot. */
async function litShare(canvas: Locator, threshold: number): Promise<number> {
  const data = await canvas.evaluate((element) => ({ ...(element as HTMLCanvasElement).dataset }));
  const png = decode(await canvas.screenshot());
  const [cx, cy, rx, ry] = [data.cx, data.cy, data.rx, data.ry].map(Number);
  let bright = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const i = (y * png.width + x) * png.channels;
      if (Math.max(png.data[i], png.data[i + 1], png.data[i + 2]) > threshold && ((x + 0.5 - cx) / (rx + 2)) ** 2 + ((y + 0.5 - cy) / (ry + 2)) ** 2 <= 1) bright += 1;
    }
  }
  return bright / (Math.PI * rx * ry);
}

test("globe: Moon textured, relief loaded, a marker opens its site", async ({ page }, info) => {
  const errors = watchForErrors(page);
  await page.goto("/");
  await expect(page.locator(".scene")).toHaveAttribute("data-relief", "true", { timeout: 60_000 });
  await expect(page.locator(".scene")).toHaveAttribute("data-ready", "true");
  await expect(page.locator(".markers .marker")).toHaveCount(sites.length);
  await page.waitForTimeout(800);
  await shot(page, "globe", info.project.name);
  await page.locator(".markers .marker", { hasText: "Malapert Massif" }).dispatchEvent("click");
  await expect(page).toHaveURL(/#\/site\/malapert_massif/);
  expect(errors).toEqual([]);
});

test("polar map: scale bar, cursor readout, toggle and marker", async ({ page }, info) => {
  const errors = watchForErrors(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await expect(page.locator(".scene-map")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("scale-label")).toHaveText(/^\d+ (km|m) at the pole$/);
  const box = (await page.locator(".scene-map").boundingBox())!;
  // The pole is at the centre when the map opens.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId("cursor-readout")).toHaveText(/^(89\.9\d\d|90\.000)° S/);
  await page.locator(".map-image").evaluate((image: HTMLImageElement) => image.decode());
  await shot(page, "map", info.project.name);
  await page.locator(".markers .marker", { hasText: "Haworth" }).dispatchEvent("click");
  await expect(page).toHaveURL(/#\/site\/haworth_floor/);
  expect(errors).toEqual([]);
});

test("coordinates: out-of-range values are refused with a reason, valid ones open the point", async ({ page }, info) => {
  const errors = watchForErrors(page);
  await page.goto("/#/map");
  const lat = page.getByLabel("Latitude");
  const lon = page.getByLabel("Longitude");
  const open = page.getByRole("button", { name: "Open point" });
  await lat.fill("-45");
  await lon.fill("10");
  await open.click();
  await expect(page.getByRole("alert")).toContainText("outside the south polar region");
  await lat.fill("-85");
  await lon.fill("200");
  await open.click();
  await expect(page.getByRole("alert")).toContainText("out of range");
  await lat.fill("north");
  await open.click();
  await expect(page.getByRole("alert")).toContainText("not a number");
  await lat.fill(String(POINT.lat));
  await lon.fill("12.5");
  await open.click();
  await expect(page).toHaveURL(/#\/point\/-82,12\.5/);
  await expect(page.getByRole("heading", { name: "Custom point" })).toBeVisible();
  await expect(page.getByText("3D terrain and lit or blocked answers exist only for the curated sites")).toBeVisible();
  await expect(page.getByRole("button", { name: "Terrain" })).toHaveCount(0);
  await expect(page.getByTestId("sky")).toHaveAttribute("data-drawn", "true");
  await page.waitForTimeout(300);
  await shot(page, "point-sky", info.project.name);
  expect(errors).toEqual([]);
});

test("site: terrain, sky and geometry scenes, readouts with units", async ({ page }, info) => {
  const errors = watchForErrors(page);
  const { timeMs } = halfHiddenSunTime();
  await page.goto(`/#/site/${RIM}?t=${timeMs}`);
  await expect(page.locator(".scene")).toHaveAttribute("data-ready", "true");
  await page.waitForTimeout(600);
  await shot(page, "site-terrain", info.project.name);

  await expect(page.getByTestId("sun-verdict")).toHaveText(/^(Yes|No|Uncertain)$/);
  await expect(page.getByTestId("sun-fraction")).toHaveText(/%$/);
  await expect(page.getByTestId("sunset")).toHaveText(/\d+ h \d\d min|None in the|not in view/, { timeout: 60_000 });
  await expect(page.getByTestId("battery")).toHaveText(/^\d+ Wh of \d+ Wh \(\d+ %\)$/);
  for (const unit of ["W/m²", "° from north", "° across", "% of its disc"]) await expect(page.locator(".panel").getByText(unit).first()).toBeVisible();

  await page.getByRole("button", { name: "Sky", exact: true }).click();
  await expect(page.getByTestId("sky")).toHaveAttribute("data-drawn", "true");
  await page.waitForTimeout(300);
  await shot(page, "site-sky", info.project.name);
  await page.getByRole("button", { name: /Magnify/ }).click();
  await expect(page.getByText("drawn 10× larger than real")).toBeAttached();
  await page.getByRole("button", { name: "Whole sky" }).click();
  await page.waitForTimeout(200);
  await shot(page, "site-sky-whole-magnified", info.project.name);

  await page.getByRole("button", { name: "Geometry", exact: true }).click();
  await expect(page.getByTestId("sun-distance")).toHaveText(/^1\d\d,\d{3},\d{3} km$/);
  await expect(page.getByTestId("earth-distance")).toHaveText(/^[34]\d\d,\d{3} km$/);
  await expect(page.getByTestId("separation")).toHaveText(/^\d+\.\d°$/);
  await page.waitForTimeout(300);
  await shot(page, "site-geometry", info.project.name);
  expect(errors).toEqual([]);
});

test("time: play advances the UTC time, pause stops it, the date field moves the window", async ({ page }) => {
  await page.goto(`/#/site/${RIM}?t=${label.t0_ms + 48 * HOUR}`);
  const now = page.getByTestId("time-now");
  await expect(now).toHaveText(/UTC$/);
  const before = await now.textContent();
  await page.getByRole("button", { name: "Play" }).click();
  await expect(now).not.toHaveText(before!, { timeout: 10_000 });
  await page.getByRole("button", { name: "Pause" }).click();
  const paused = await now.textContent();
  await page.waitForTimeout(500);
  await expect(now).toHaveText(paused!);
  await page.getByLabel("Window starts (UTC)").fill("2030-03-01T12:00");
  await expect(now).toHaveText(/1 Mar 2030, 12:00 UTC/);
  await expect(page).toHaveURL(new RegExp(`t=${Date.UTC(2030, 2, 1, 12)}`));
});

test("about: credits come from assets.json", async ({ page }, info) => {
  await page.goto("/#/map");
  await page.getByRole("button", { name: "About" }).click();
  await expect(page.getByTestId("credit")).toHaveCount(4);
  await expect(page.locator(".panel")).toContainText("Courtesy of NASA/SDO and the AIA, EVE, and HMI science teams.");
  await expect(page.locator(".panel")).toContainText("NASA Earth Observatory");
  await expect(page.locator(".panel")).toContainText("2026.11.16_00:23:15_TAI");
  await shot(page, "about", info.project.name);
});

test("failure and build hygiene", async ({ page }) => {
  await page.route("**/data/manifest.json", (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("could not be loaded");
  expect(existsSync("dist/data/manifest.json")).toBe(true);
  expect(existsSync("dist/data-mock")).toBe(false);
});

test.describe("measured on screen pixels", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1000, "the probe needs a stage at least 320 pixels high and wide");

  test("the terrain hides the same share of the Sun as the engine computes (within 5 %)", async ({ page }, info) => {
    const { timeMs, fraction } = halfHiddenSunTime();
    await page.goto(`/#/site/${RIM}?t=${timeMs}&probe=sun`);
    const canvas = page.getByTestId("sky");
    await expect(canvas).toHaveAttribute("data-drawn", "true");
    await page.waitForTimeout(300);
    expect(Number(await canvas.getAttribute("data-sun-fraction"))).toBeCloseTo(fraction, 9);
    const onScreen = await litShare(canvas, 40);
    console.log(`Sun at ${new Date(timeMs).toISOString()}: engine ${fraction.toFixed(4)}, screen ${onScreen.toFixed(4)}`);
    await shot(page, "probe-sun-half-set", info.project.name);
    expect(Math.abs(onScreen - fraction)).toBeLessThan(0.05);
  });

  test("the Earth's lit share on screen matches (1 + cos phase) / 2 within 2 %, magnify off and on", async ({ page }, info) => {
    const { timeMs, lit } = halfLitEarthTime();
    await page.goto(`/#/point/${POINT.lat},${POINT.lon}?t=${timeMs}&probe=earth`);
    const canvas = page.getByTestId("sky");
    await expect(canvas).toHaveAttribute("data-drawn", "true");
    await page.waitForTimeout(300);
    expect(Number(await canvas.getAttribute("data-earth-lit"))).toBeCloseTo(lit, 9);
    const centre = [await canvas.getAttribute("data-cx"), await canvas.getAttribute("data-cy")];
    const plain = await litShare(canvas, 4);
    await shot(page, "probe-earth-phase", info.project.name);
    await page.getByRole("button", { name: /Magnify/ }).click();
    await expect(canvas).toHaveAttribute("data-magnify", "10");
    await page.waitForTimeout(300);
    const magnified = await litShare(canvas, 4);
    console.log(`Earth at ${new Date(timeMs).toISOString()}: formula ${lit.toFixed(4)}, screen ${plain.toFixed(4)}, magnified ${magnified.toFixed(4)}`);
    expect(Math.abs(plain - lit)).toBeLessThan(0.02);
    expect(Math.abs(magnified - lit)).toBeLessThan(0.02);
    // Magnifying changes size only: the disc's centre stays where it was.
    expect([await canvas.getAttribute("data-cx"), await canvas.getAttribute("data-cy")]).toEqual(centre);
  });

  test("frame rate of the site terrain while time is playing (reported, not asserted)", async ({ page }) => {
    await page.goto(`/#/site/${RIM}?t=${label.t0_ms + 48 * HOUR}`);
    await expect(page.locator(".scene")).toHaveAttribute("data-ready", "true");
    await page.getByRole("button", { name: "Play" }).click();
    const fps = await page.evaluate(() => new Promise<number>((resolve) => {
      let frames = 0;
      const start = performance.now();
      const tick = () => {
        frames += 1;
        if (performance.now() - start < 3000) requestAnimationFrame(tick);
        else resolve((frames * 1000) / (performance.now() - start));
      };
      requestAnimationFrame(tick);
    }));
    console.log(`Terrain scene while playing: ${fps.toFixed(1)} frames per second (headless Chromium, software or GPU rendering as available)`);
    expect(fps).toBeGreaterThan(0);
  });
});
