import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The app reads the engine's real products unless a developer points it elsewhere
// (for example VITE_DATA_FOLDER=/data-mock to exercise the mock banner).
process.env.VITE_DATA_FOLDER ??= "/data";

/**
 * Keep mock data out of the production build.
 *
 * `web/public/data-mock/` is written and tested by the Python engine, so it stays in the
 * repository. Vite copies all of `public/` into `dist/`; this plugin removes the mock folder
 * again once the bundle is written, so invented terrain can never be served as the real app.
 */
function excludeMockData(): Plugin {
  let outDir = "dist";
  return {
    name: "exclude-mock-data",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      rmSync(resolve(outDir, "data-mock"), { recursive: true, force: true });
    },
  };
}

// Configure Vite to serve the React browser application and its worker modules.
export default defineConfig({
  plugins: [react(), excludeMockData()],
});
