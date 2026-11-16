import { defineConfig } from "@playwright/test";

/**
 * Browser tests and screenshots.
 *
 * They run against the production build (`vite preview`), in the two viewports the app must
 * work at: a 1440×900 laptop and a 390×844 phone. Screenshots go to docs/screenshots/.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: [["list"]],
  workers: 4,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: { baseURL: "http://localhost:4173" },
  webServer: {
    command: "npm run build && npm run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
    {
      name: "phone",
      use: { browserName: "chromium", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
    },
  ],
});
