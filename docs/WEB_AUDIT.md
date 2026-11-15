# Audit of the web engine (2026-11-15)

Scientific and mathematical audit of `web/engine/` and its Web Worker, and of how they read what the Python engine writes. Every "before" value was printed by the engine as it was found, on the input given. Every "after" value is asserted by a test in `web/engine/tests/audit/`. Expected values come only from SPICE (`altaz.json`, `events.json`), JPL Horizons (`python/tests/data/horizons_altaz.json`), the Python engine (`python_reference.json`, written by `python/scripts/build_audit_fixtures.py`), or closed forms and hand calculations written in the tests. They never come from the TypeScript helpers being tested.

## Findings

| # | Area | Where | Input | Before | Expected | After |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Site height | `worker.ts`, `client.ts` | Any site from `sites.json` | Read `site.elev_m` and `site.mast_m`, which `Site` does not have: every worker direction was **NaN**, so there were no events and no metrics | Height from the skyline record (`elev_m + mast_m`) | Fixed. `evaluate.ts` takes heights from the skyline. `contracts.test.ts` runs all 10 real sites |
| 2 | Earth radius | `astro.ts` | Earth at 384,400 km | Disc radius 0.950721° (equatorial 6378.137 km) | 0.947533° (polar 6356.7519 km, the fixtures' value) | Fixed. With the old radius every Earth event in `events.json` was **3 to 6 minutes** early or late (pass mark 60 s). Now the worst is 2.7 s |
| 3 | Interpolation | `astro.ts` | Rows of y = t³, first interval, t = 0.5 | 0.0625 (Catmull-Rom, edge row duplicated) | 0.125 | Fixed. The handoff's 4-point Lagrange with the 4 nearest rows: within 1.8e-12 km of Python `interpolate_rows` |
| 3b | Outside the table | `astro.ts` | t after the last row | Clamped silently (a frozen Sun) | Refused | `RangeError`. Windows are clipped to the table |
| 4 | Skyline read | `astro.ts` | Entries [0, 10, 0, …] at 1°, azimuth 0.6 | 6° (interpolated) | 10° (step function: wedge maximum) | Fixed. A Sun at 8° there was called clear; now it is blocked |
| 5 | Verdict rule | `visibility.ts` | Sun centre 0.1° above a flat skyline, error 0.03° | "uncertain" (strict whole-disc rule at the centre azimuth) | "visible" (approved rule: lit iff `f_low > 0`) | Fixed. `fraction_low`, `fraction` and `fraction_high` are reported. `verdict.ts` removed |
| 6 | Disc fraction | `visibility.ts` | Flat skyline, offset d = 0.3 radii | 0.688407 (64 strips over an interpolated skyline) | 0.688081 (circle segment) | Exact closed form per wedge: equal to 1e-9 at every offset, and within 2e-3 of a brute-force count across north |
| 7 | Events | `events.ts` | A graze 0.001° high for 6 minutes between two 10-minute samples | Missed (the scan compared signs of samples only) | Rise and set at peak ± 3 min | Port of the Python reference search (turning points, first and last interval, bisection): found to 1 s |
| 8 | Metrics | `metrics.ts` | A window dark throughout | `longest_night_ms` = 0 | The window's length | Fixed. Exact intervals from crossings against skyline ± error. Countdowns run from the chosen time |
| 9 | Panel tilt | `power.ts` | Tilt 0 (lying flat), Sun at 1° | Incidence 0.9998 | sin 1° = 0.0175 | Fixed. Tilt from horizontal, normal elevation 90 − tilt |
| 10 | Battery | `power.ts` | 50 Wh, 100 W load, no Sun, hourly samples | Runs out at 3,600,000 ms | 1,800,000 ms | Fixed by interpolating within the step. No samples with initial 500 Wh and capacity 100: was 500, now 100. Impossible settings are refused |
| 11 | Loader | `data.ts` | A file longer than its label | Accepted | Refused | Exact sizes, `version`, manifest `bytes`, and a little-endian check |
| 12 | Worker loop | `web/src/App.tsx` | Any site | The timeline window was a new object every render and an effect dependency, so each worker result started another worker | One evaluation per change | Fixed in PR #22 |
| 13 | UI model | `web/src/visual-model.ts` | Chosen time after a sunset that is still inside the window | Countdown to that past sunset (negative) | Next sunset after the chosen time | Fixed: uses the engine's metrics |

## Checked and correct

- Degrees at every public boundary; radians only inside trigonometry.
- Longitudes −180 to 180 and azimuth 0 to 360 (excluded), from north, clockwise.
- UTC milliseconds; km for vectors, m for heights.
- Site position at R + elev + mast. East/north/up are orthonormal and right-handed down to 1e-5° from the pole. The pole itself is moved to −89.99999°, as the engine does.
- Parallax: body minus eye position.
- Elevation by `atan2`, so no clamping is needed. `asin` in the disc radius is clamped.
- Irradiance 1361 × (1 AU / d)² × fraction, with AU = 149,597,870.7 km.
- Switching data folders is one setting (`VITE_DATA_FOLDER`). Nothing hard-codes sites, sizes or steps.
- Fixtures: nothing that produces `altaz.json` or `events.json` has changed since they were built (2026-11-14), and both copies of the timetable are byte-identical. So they were not regenerated.

## One property that is not exact on the real sky

"The visible fraction never decreases as the Sun rises against a fixed skyline" holds **exactly** when the Sun rises relative to the terrain with the disc's shape on the sky fixed. That's tested to 1e-12.

On the real sky a rising disc also spreads in azimuth (offset = arc / cos elevation). So where a wedge is lower than its neighbours, the strip of disc inside it narrows a little. The largest drop seen in 60 random rough skylines was 2.8e-6 per 0.01° of rise, at elevations up to 8°. It's physical, not numerical, and a test checks it stays within its first-order bound. At the south pole the Sun stays within a few degrees of the horizon, where the effect is smaller still.

## Precision limits

- **Float32 timetable:** within 0.0000017° for the Sun and 0.0000005° for the Earth (`docs/ACCURACY.md`).
- **The browser chain against SPICE:** worst 2.6e-5° on the 61 `altaz.json` cases, and 2.6e-5° against the 60 Horizons rows.
- **Disc fraction:** exact for the step skyline, apart from the flat-tangent-plane approximation across the disc (about ρ² tan(el) / 2, below 0.00001° here).
- **No NaN or Infinity found in 3,000 random sites, times, heights and masts.** That covers latitudes 80°S to the pole, heights −5 to 8 km and masts 0 to 100 m.
