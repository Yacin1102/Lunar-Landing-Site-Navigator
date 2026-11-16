# Rebuild the Lunar web UI from scratch (south pole only)

## Context

The current UI (PRs #25 to #29 plus uncommitted work on `ui/ops-dashboard`) is cluttered, loads three.js from a CDN, uses a 2k Moon texture of unrecorded origin and draws Sun and Earth with invented sizes. The engine underneath (`web/engine/`, audited in PRs #24 and #30) is sound and stays. The goal is a new, minimal, accurate UI in nine reviewable PRs: every number from engine files or tested TS math, only NASA imagery, everything not to scale labelled.

## Where the brief and the repo disagree (resolved)

| Brief says | Repo reality | What the plan does |
| --- | --- | --- |
| Skyline from `/api/skyline` for custom points | API removed 2026-11-15; `python/` is off limits | **Your choice:** custom points show directions only: Sun/Earth at true az/el, sizes, distances, and the smooth-sphere horizon as a dashed line labelled "no terrain data". No verdict, no visible fraction, no countdowns, no battery. Skyline service logged in `docs/ENGINE_REQUESTS.md`. |
| Terrain 257×257, 20 km | Real labels: 241×241, 20 m spacing, 4.8 km; shade 17×17 at 300 m | Read `n`, `spacing_m`, `size_m` from labels (handoff rule 7). A 20 km patch is logged as an engine request. Scale bar shows the real size. |
| Earth radius 6371 km | Engine uses 6356.7519 km (polar, audited) | Use `discRadiusDeg` from `web/engine/astro.ts` so the drawn disc equals the disc the visibility math uses. Gives 1.8 to 2.0°, as the brief expects. |
| Delete mock data | `web/public/data-mock/` is written and tested by `python/` | Folder stays on disk. Default data folder becomes `/data`; a small Vite plugin removes `data-mock` from `dist/`; a test asserts the build has none. Vitest reads fixtures from disk only. |
| Uncommitted work on `ui/ops-dashboard` | Memory said do not touch | **Your choice:** commit as a local backup on that branch, start from `main`, salvage only `polar.ts` and `shade.ts` math (with tests) after review. |

## Ground rules for every part

- `git fetch`, branch `ui/NN-name` from fresh `origin/main`, one PR against `main` (never stacked). A part starts only after the previous PR is merged.
- Keep untouched: `web/engine/**` (types, loaders, astro, visibility, events, power, metrics, worker, all tests and fixtures), `web/src/formatting.ts`, `web/src/url-state.ts` and their tests.
- Reuse, do not rewrite: `loadDataBundle` (`engine/data.ts`), `directionsAt`, `interpolateBody`, `discRadiusDeg`, `skylineAt` (`engine/astro.ts`), `visibleDiscFraction`, `classifyVisibility` (`engine/visibility.ts`), `evaluateInWorker` (`engine/client.ts`), `solarIrradianceWm2`, `simulateBattery` (`engine/power.ts`).
- Gates per part: `npm test`, `npm run build`, `npm run e2e` (Playwright, 1440×900 and 390×844, zero console errors), screenshots in `docs/screenshots/`, each one looked at. Then `docs/PROGRESS.md` (done, exact next step), `docs/WEB_ARCHITECTURE.md` and `docs/WEB_UI.md` updated, PR opened with real test output and the shared rules applied. Then stop.
- New dependencies: `three` (bundled, replaces the CDN), `@playwright/test`; dev only for the asset script: `sharp`, `geotiff`; `fast-png` to decode the 16-bit elevation PNG in the browser (browsers flatten PNG to 8 bits on texture upload).

## Layout (target `web/src/`)

```
main.tsx  App.tsx            shell, routing between scenes via url-state
state/                       selected site or custom point, time, playback, panel
ui/                          TopBar, SidePanel, Readout, CoordinateInput, TimeBar, About
scenes/globe/  scenes/map/  scenes/site/  scenes/sky/  scenes/geometry/
lib/                         pure tested math: angular-size, earth-phase, coords,
                             polar (salvaged), shade (salvaged), log-scale, assets
styles/                      tokens.css (one accent, one sans font), layout.css
web/scripts/fetch-assets.mjs web/e2e/*.spec.ts  web/playwright.config.ts
```

Look: near-black background, one accent, one sans font (self-hosted), a single side panel, top bar with Globe ↔ Map toggle and About. Imagery fills the screen; on 390×844 the panel becomes a bottom sheet.

## Parts

**1. Cleanup + shell.** Backup commit on `ui/ops-dashboard`. From `main`: delete `App.tsx`, `App.test.tsx`, `SpaceScene.tsx`, `styles.css`, `visual-model.ts`, `public/assets/lroc_color_2k.jpg`. Default data folder `/data`, dist-exclusion plugin for `data-mock`, mock banner kept for `data_kind: "mock"`. Shell with empty scene slots, loading and error states. Playwright set up. Add `docs/UI_PLAN.md`, `docs/ENGINE_REQUESTS.md` (skyline for custom points, 20 km terrain patch, Earth sub-Moon point via `spiceypy.subpnt` in `IAU_EARTH` as new ephem columns).

**2. Assets.** `web/scripts/fetch-assets.mjs`: download to `web/assets-raw/` (gitignored), record URL, date and SHA-256 in `web/public/assets/assets.json`, convert: Moon colour → 4096×2048 JPG; LDEM → 4096×2048 16-bit PNG with its metres-per-count from the SVS page; hillshade → downsampled PNG + JSON sidecar (projection, centre, metres per pixel, extent read from the GeoTIFF tags); Sun HMII → disc crop, transparent outside, `sun/sun_hmi_2048.png` with the image date; Blue Marble 12 months → `earth/bmng_MM.jpg`. `CREDITS.md` with SDO wording per its rules page. Tests: every listed file exists with the recorded checksum and size; sidecar round-trips a known lat/lon. Risk: about 30 to 40 MB committed; reported in the PR.

**3. Globe.** three.js sphere, colour texture, displacement from the decoded 16-bit PNG (exaggeration, if any, labelled on screen), camera opening on the south pole, damped orbit and zoom. Markers from `sites.json` placed with the same lat/lon → MOON_ME formula as `sitePosition`. Click → site route.

**4. Polar map + toggle + coordinate input.** Hillshade on a canvas using the sidecar; `lib/polar.ts` for projection both ways; scale bar computed from metres per pixel (true at the pole, labelled); cursor lat/lon readout; same markers. `CoordinateInput`: latitude within the manifest's `service_region`, longitude -180 to 180, clear messages; shared by both scenes. Tests: validation cases, projection round trip, marker positions against `sites.json`.

**5. Site 3D terrain.** Mesh from `terrain/{id}.bin` per the handoff formula (east, north, height; no vertical exaggeration). Lighting per shade cell: lit when the Sun is above that cell's skyline at the Sun's azimuth, brightness = normal · Sun (`lib/shade.ts`), bilinear across cells for display, whole scene scaled by the site's visible Sun fraction from the full skyline. North arrow, scale bar, `dem` and `resolution_m` shown. Custom point: no 3D, one-line note.

**6. Sky view + Sun/Earth.** Camera at the eye inside a sky dome; drag to look, zoom FOV; 360° strip overview. Skyline silhouette as an opaque step-function mesh from `skylines/{id}.json`, error band as a thin outline. Sun: textured disc, size `2·discRadiusDeg` from the interpolated distance each frame, restrained bloom. Earth: textured sphere of the month's Blue Marble, lit by a directional light along the engine's Sun direction, fixed orientation with a "rotation approximate" note; ghost + "below horizon" label when under the skyline. Both drawn behind the silhouette. "Magnify ×N" toggle scales size only, labelled. Tests: angular size; Earth lit fraction `(1+cos phase)/2` against a fixture saved from JPL Horizons (query stored beside it); altaz 0.01° and events 60 s (existing audit tests, kept). Playwright with a `?probe` mode (no bloom, no labels): pixel count of the visible Sun at a partly-set fixture time within 5 % of `visibleDiscFraction`; Earth lit pixel fraction within 2 %, magnify on and off.

**7. Time controls + readouts.** UTC date-time picker clamped to the timetable span, slider, play/pause, speed. Readouts with units: Sun elevation/azimuth, visible fraction as the range `f_low` to `f_high` with the lit/blocked/uncertain verdict, irradiance W/m², time to sunset, Earth elevation, time to Earthset, battery state. Battery and panel settings are user inputs shown as assumptions. Evaluation in the existing worker. Frame rate measured and noted.

**8. Geometry panel.** SVG in the plane through Moon, Sun and Earth: true Sun–Moon–Earth angle, distances from `ephem.bin` on a labelled log scale, real Sun and Earth textures as icons, "not to scale" label. Tests: log-scale mapping, angle against the engine vectors.

**9. Polish.** About panel (credits, data provenance, accuracy notes), mobile pass, keyboard and focus, final screenshot set, docs complete.

## Risks

- 16-bit displacement and 4k textures on phones: fall back to lower mip or vertex-baked relief; noted if used.
- Pixel-count gates depend on anti-aliasing: probe mode renders at a fixed zoom with a large disc.
- "latest" SDO image changes daily: downloaded once, date recorded, never re-fetched by the build.
- The hillshade file's exact size and tags are unknown until read; the sidecar is generated from the file, not typed in.
- 60 fps: shade lighting is recomputed only when the time changes, in a typed-array pass.

## Verification

`cd web; npm test; npm run build; npm run e2e`, then `npm run dev` and open both viewports. Python is untouched; `.venv\Scripts\python -m pytest python/tests -v -rs` is run once in Part 1 to confirm the mock folder still passes.
