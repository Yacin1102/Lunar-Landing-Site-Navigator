---
name: check-contracts
description: Verify that files written to web/public/data/ and API responses match the contracts in spec/ENGINE_GUIDE.md (fields, units, sizes, order, version). Use after building any product or changing how records or the server are written.
---

Check every product in `web/public/data/` (or the one named in $ARGUMENTS) against `spec/ENGINE_GUIDE.md`:

- Exactly the contract fields, including `version`; units and ranges follow the shared rules.
- Binary file sizes match their labels; first and last values are sane.
- Product-specific sanity: timetable distances and start time (16 Nov 2026); skyline and `skyline_err_deg` length = 360 / `az_step_deg`, with every error bound positive and finite; every site and API point inside the south polar service region; exactly 10 sites, each with a recorded source; terrain centre value 0; unit normals; `has_terrain`/`has_shade_grid` true only when files exist.
- `/api/skyline` for a curated site equals that site's file.

Keep these checks as pytest tests so they run every time. Report pass or fail with evidence.
