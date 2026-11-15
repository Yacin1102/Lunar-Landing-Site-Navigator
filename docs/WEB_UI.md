# Web interface

The browser UI is deliberately limited to `web/src/` and consumes the existing engine through its public functions and worker client. It never opens NASA files, edits generated contracts, or duplicates astronomy formulas.

- The top bar selects a curated site and UTC instant, switches Beginner/Expert mode, opens Details, or navigates to the separate comparison page.
- The main view shows one of Sky view, 3D terrain, or the south-polar map. The status column keeps the first screen focused on Sun visibility, the next transition, Earth contact, and power.
- The bottom timeline uses the existing direction, visibility, event, and battery calculations; its cursor is draggable and its play button advances the active UTC instant.
- Expert mode opens a right-side Details drawer with precision, DEM, uncertainty and metrics.
- Sites come only from `sites.json`: there are no custom coordinates and no server, so every answer comes from a precomputed, error-bounded skyline.
- Scenario selections and UTC dates remain stored in the `scenarios` query parameter, capped at four scenarios; comparisons are shown on their own page.
