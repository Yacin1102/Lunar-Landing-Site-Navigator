# Web application architecture

The web application is a static site. It reads prepared products from one folder (`VITE_DATA_FOLDER`; `web/vite.config.ts` sets it to `/data`, the real sites, unless it is already set) and does every calculation that depends on the chosen time or settings in the browser. It never opens NASA files and needs no server.

| Module | Job | Reads | Writes |
| --- | --- | --- | --- |
| `web/engine/data.ts` | Load and check the configured data folder: `version`, binary sizes against labels and against the manifest's `bytes`, little-endian decoding | `manifest.json`, labels, binary products | `DataBundle` |
| `web/engine/astro.ts` | Timetable interpolation (4-point Lagrange; refuses times outside the table), site position, east/north/up frame, azimuth and elevation, disc radii (Sun 695,700 km, Earth 6356.7519 km), step-function skyline reading | Timetable, site, time | `Direction` |
| `web/engine/visibility.ts` | Exact visible fraction of a disc against the skyline, nominal and ± error, the disc's clearance above the skyline, and the lit / blocked / uncertain verdict | `Direction`, `Skyline` | `Visibility` |
| `web/engine/events.ts` | Zero crossings of a clearance curve (10-minute scan, turning-point search, bisection): sunrise, sunset, Earthrise, Earthset | Timetable, `Skyline`, window | Event times |
| `web/engine/metrics.ts` | Intervals from crossings; sunlight, uncertain and Earth hours, longest night, both-visible windows, countdowns from the chosen time | Crossings, events | `MissionMetrics` |
| `web/engine/power.ts` | Irradiance, panel factors (flat, tracking, fixed with tilt from horizontal), battery integration with exact run-out time | Sun direction, visible fraction, settings | Power, charge history |
| `web/engine/evaluate.ts` | One site, time and window: directions, verdicts, events, metrics. Eye height from the skyline record | All of the above | `Evaluation` |
| `web/engine/worker.ts`, `client.ts` | Run `evaluateSite` in one long-lived Web Worker; the timetable is sent once | `DataBundle` | `Evaluation` |
| `web/src/formatting.ts` | Format durations, powers, angles and UTC times | Numeric values, UTC milliseconds | Display strings |
| `web/src/state/route.ts`, `useRoute.ts` | The address: scene, site or point, and time, as the URL hash | `location.hash` | `Route` |
| `web/src/state/useData.ts` | Load the data once; report loading, error or ready | `loadDataBundle` | `DataState` |
| `web/src/lib/sites.ts` | Group sites by category, write headings and positions | `Site[]` | Display strings |
| `web/src/App.tsx` | The shell: top bar, stage, one side panel; loading, error and mock-data states | Route, `DataState` | React view |
| `web/src/ui/` | `TopBar` (Globe/Map toggle), `Stage` (scene slot), `SiteList`, `SiteSummary`, `PointSummary`, `Facts` | Route, `DataBundle` | React view |
| `web/vite.config.ts` | Default data folder `/data`; remove `data-mock` from `dist/` after the build | `public/` | `dist/` |
| `web/scripts/fetch-assets.mjs` | Download the NASA imagery once, convert it to web sizes, record every file. Not part of the app: run by hand (`npm run fetch-assets`) | NASA servers, `web/assets-raw/` | `web/public/assets/`, `assets.json` |
| `web/scripts/assets.test.ts` | Check the committed pictures against `assets.json` and against what the app will assume about them | `web/public/assets/` | Test results |
| `web/e2e/`, `web/playwright.config.ts` | Browser tests and screenshots at 1440×900 and 390×844 against the production build | `dist/` | `docs/screenshots/` |

The interface is being rebuilt in nine parts (`docs/UI_PLAN.md`). The scenes (globe, polar map, site terrain, sky view, geometry) do not exist yet; this file gains a row for each as it is built.

## Main data flow

```mermaid
flowchart LR
  Files["web/public/data/<br/>(written once by the Python engine)"] --> Loader[loadDataBundle<br/>checks versions and sizes]
  Loader --> Data[useData<br/>loading / error / ready]
  Hash[URL hash] --> Route[useRoute]
  Route --> App
  Data --> App[App shell]
  App --> TopBar
  App --> Stage[Stage: scene slot]
  App --> Panel[Side panel]
  TopBar -- navigate --> Hash
  Panel -- navigate --> Hash
```

The worker client (`evaluateInWorker`) is not called by the shell yet. It is wired in with the time controls and readouts (part 7).

## Inside one evaluation

```mermaid
flowchart TD
  T[ephem.bin: Moon-centre vectors, km] --> L[4-point Lagrange at the chosen time]
  L --> P["subtract the eye position<br/>R + elev_m + mast_m (from the skyline)"]
  P --> D[azimuth, elevation, distance<br/>in the site's east/north/up frame]
  D --> F["visible fraction, exact per wedge<br/>against skyline, skyline + err, skyline - err"]
  F --> V{"f_low > 0: lit<br/>f_high = 0: blocked<br/>else uncertain"}
  D --> C[clearance of the disc's top above the skyline]
  C --> E[crossings: scan, turning points, bisection]
  E --> M[intervals: lit, possibly lit, Earth in view]
  M --> K[metrics and countdowns from the chosen time]
  F --> W[power: 1361 x AU/d squared x fraction x panel factor]
  W --> B[battery between 0 and capacity]
```

## Imagery

```mermaid
flowchart LR
  SVS["NASA SVS CGI Moon Kit<br/>colour 8k TIFF, elevation 16-bit TIFF"] --> Script
  PGDA["PGDA LOLA product 90<br/>80 m hillshade GeoTIFF"] --> Script
  SDO["SDO/HMI<br/>latest 2048 continuum JPEG"] --> Script
  BMNG["Blue Marble Next Generation<br/>12 monthly JPEGs"] --> Script
  Script[fetch-assets.mjs<br/>run once, by hand] --> Raw["web/assets-raw/<br/>(ignored by git)"]
  Script --> Out["web/public/assets/<br/>(committed)"]
  Script --> Manifest[assets.json<br/>URL, dates, SHA-256]
  Out --> App[scenes, from part 3 on]
```

| File | Size | What the app must know |
| --- | --- | --- |
| `moon/lroc_color_4096.jpg` | 4096 x 2048 | Latitude/longitude grid, 0 degrees longitude in the middle, north at the top |
| `moon/ldem_4096_uint16.png` | 4096 x 2048, 16-bit | Same grid. Height above the 1737.4 km sphere in metres = `count * 0.5 - 10000`. A browser flattens a PNG to 8 bits when it is used as a texture, so the app must decode this file itself |
| `hillshade/south_pole_hillshade.png` + `.json` | 3800 x 3800 | South polar stereographic, pole at the centre, 160 m per pixel, to 80 degrees south. The sidecar gives the corner coordinates in metres and the pixel-to-map formula |
| `sun/sun_hmi_2048.png` | 1891 x 1891, grey + alpha | Cropped to the disc: the picture's width is the Sun's diameter. Greyscale with real limb darkening |
| `earth/bmng_01.jpg` to `bmng_12.jpg` | 4096 x 2048 | Latitude/longitude grid, 0 degrees longitude in the middle. Use the month of the selected UTC date |

The hillshade's projection values are not typed in: the script reads them from the GeoTIFF's tags and writes them to the sidecar. The Sun's disc is found in the image itself (the longest run of bright rows and columns), not assumed.

## Component structure

```mermaid
flowchart TB
  App --> TopBar
  App --> Stage
  App --> Panel
  Panel --> SiteList
  Panel --> SiteSummary
  Panel --> PointSummary
  SiteSummary --> Facts
  PointSummary --> Facts
```

At most one side panel is open. Which one depends only on the route.

## Tests

- `cd web; npm test`: unit tests (vitest). The audit tests in `web/engine/tests/audit/` compare the engine with SPICE, JPL Horizons, the Python engine and closed forms, and validate every data file against `docs/schemas/` (`docs/WEB_AUDIT.md`). The UI adds tests for the route and the site helpers, the latter against the real `sites.json`. `web/scripts/assets.test.ts` checks every committed picture: present, same size and SHA-256 as `assets.json`, global maps 4096 x 2048, the elevation map really 16-bit with lunar heights in the right places (and within 400 m of the engine's own ground height on three crater floors), the Sun transparent outside its disc and darker at the limb, the hillshade sidecar consistent and reaching 80 degrees south, every credit present, raw downloads ignored by git.
- `cd web; npm run e2e`: builds the app, serves the build and runs the browser tests (Playwright, Chromium) in both viewports. They assert zero console errors and failed requests, that every site of `sites.json` is listed, that a failed data load shows an error and no result, and that `dist/` holds the real data and no mock data. First use on a machine: `npx playwright install chromium`.
