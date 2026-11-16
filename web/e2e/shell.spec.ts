import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const sites = (JSON.parse(readFileSync("public/data/sites.json", "utf8")) as { sites: { id: string; name: string }[] }).sites;

/** Collect console errors and failed requests so a test can assert there were none. */
function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => errors.push(`request failed: ${request.url()}`));
  return errors;
}

test("the shell lists every site from sites.json and has no console errors", async ({ page }, testInfo) => {
  const errors = watchForErrors(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sites", level: 1 })).toBeVisible();
  for (const site of sites) await expect(page.getByRole("button", { name: new RegExp(site.name) })).toHaveCount(1);
  await expect(page.getByText("Mock data")).toHaveCount(0);
  await page.screenshot({ path: `../docs/screenshots/part1-shell-${testInfo.project.name}.png` });
  expect(errors).toEqual([]);
});

test("the toggle switches between globe and map", async ({ page }) => {
  await page.goto("/");
  const globe = page.getByRole("button", { name: "Globe" });
  const map = page.getByRole("button", { name: "Map" });
  await expect(globe).toHaveAttribute("aria-pressed", "true");
  await map.click();
  await expect(map).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/#\/map$/);
  await expect(page.locator("main")).toHaveAttribute("data-scene", "map");
});

test("choosing a site opens its summary, and the back link returns", async ({ page }, testInfo) => {
  const errors = watchForErrors(page);
  const site = sites[0];
  await page.goto("/");
  await page.getByRole("button", { name: new RegExp(site.name) }).click();
  await expect(page).toHaveURL(new RegExp(`#/site/${site.id}$`));
  await expect(page.getByRole("heading", { name: site.name, level: 1 })).toBeVisible();
  await expect(page.getByText("Elevation maps")).toBeVisible();
  await page.screenshot({ path: `../docs/screenshots/part1-site-${testInfo.project.name}.png` });
  await page.getByRole("link", { name: "All sites" }).click();
  await expect(page.getByRole("heading", { name: "Sites", level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});

test("an unknown site and an out-of-region point are explained, not guessed", async ({ page }) => {
  await page.goto("/#/site/not_a_site");
  await expect(page.getByRole("heading", { name: "No such site" })).toBeVisible();
  await page.goto("/#/point/-45,10");
  await expect(page.getByRole("heading", { name: "Outside the south polar region" })).toBeVisible();
  await page.goto("/#/point/-88.5,20");
  await expect(page.getByRole("heading", { name: "Custom point" })).toBeVisible();
  await expect(page.getByText("88.5000° S, 20.0000° E")).toBeVisible();
});

test("a data folder that fails to load shows an error, not a result", async ({ page }) => {
  await page.route("**/data/manifest.json", (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("could not be loaded");
  await expect(page.getByRole("alert")).toContainText("404");
});

test("the production build contains the real data and no mock data", () => {
  expect(existsSync("dist/data/manifest.json")).toBe(true);
  expect(existsSync("dist/data-mock")).toBe(false);
});
