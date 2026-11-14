# Web interface

The browser UI is deliberately limited to `web/src/` and consumes the existing engine through its public functions and worker client. It never opens NASA files, edits generated contracts, or duplicates astronomy formulas.

- Curated sites come from `sites.json`; custom coordinates request `/api/skyline`.
- An unreachable API is shown as “terrain not included; verdict unavailable”, never as a smooth-Moon verdict.
- Scenario selections and UTC dates are stored in the `scenarios` query parameter, capped at four scenarios.
- The timeline can show one lunar day, one month, or three months. Tooltips explain elevation, skyline, visibility, and battery numbers in plain language.
