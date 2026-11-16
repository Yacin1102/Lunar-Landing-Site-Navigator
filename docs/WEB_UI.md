# Web interface

The interface is being rebuilt from scratch in nine parts (`docs/UI_PLAN.md`). This file describes what exists in the code now.

## State after part 1: the shell

- **Top bar.** The app's name and one toggle, Globe or Map. On a site screen neither is pressed; choosing one returns to that overview.
- **Stage.** The large area for the scene. No scene is built yet, so it names the scene that belongs there and the part of the plan that builds it. It shows no picture and no number.
- **One side panel.** On the overviews it lists the sites of `sites.json`, grouped by `category`. On a site it shows the site's record and the data behind its answers: ground height, eye height, source maps, finest map pixel, skyline step and the largest skyline uncertainty, all read from the skyline record. On a phone the panel sits under the stage.
- **Custom point.** `#/point/{lat},{lon}` shows the position and one line saying that no terrain skyline exists for it. A point outside the manifest's `service_region` is refused with the region's bounds.
- **Loading and failure.** Until every prepared file has passed the loader's checks, only a status line is shown. If a file is missing or fails a check, the error is shown and nothing else.
- **Mock data.** If the manifest says `data_kind: "mock"`, a banner says so on every screen. The production build contains no mock data.

## Addresses

| Address | Screen |
| --- | --- |
| `#/globe` | Globe overview (default) |
| `#/map` | Polar map overview |
| `#/site/{id}` | A curated site |
| `#/point/{lat},{lon}` | A custom point, degrees, longitude east-positive |
| `?t={ms}` after any of them | Selected time, UTC milliseconds since 1970 |

## Look

True black background, one accent (pale gold, for the selected state and keyboard focus), one typeface (IBM Plex Sans, bundled with the app, with tabular figures). Tokens are in `web/src/styles/tokens.css`.

## Screenshots

`docs/screenshots/part1-*.png`, written by `npm run e2e` at 1440×900 and 390×844.
