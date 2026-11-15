# Progress

## Now (2026-11-15)

**Next:** review and merge PR #22 (cleanup), then PR B (the web engine audit, stacked on it). After that: bring the 3D view from `yacin1102-lunar-web-3d` into `main`.

**Done in PR B (web engine audit):** 13 findings, each shown with the engine's real output before the fix and asserted by a test after it (`docs/WEB_AUDIT.md`). The most serious:
- The worker's site height was NaN, so it produced no events or metrics.
- The skyline was interpolated, which could call a blocked Sun clear.
- The Earth's radius was equatorial, which put Earth events 3 to 6 minutes off.

The disc fraction is now exact per wedge. The event search is a port of the Python reference. The verdict follows the approved rule. New: `web/engine/evaluate.ts`, `web/engine/tests/audit/` (7 test files), `python/scripts/build_audit_fixtures.py` with `python/tests/test_audit_fixtures.py`, and `ajv` as a web dev dependency. `altaz.json` and `events.json` were not regenerated: nothing that makes them has changed since 2026-11-14.

**Done in PR A (cleanup):**

- **Live API and custom coordinates removed (your decision, 2026-11-15).** The app covers the 10 curated sites only and needs no server and no NASA maps. This departs from the spec (Contract 7, `/api/skyline`, and custom points): see "Proposed spec changes". Removed: `server.py`, `serve.py`, `test_api.py`, the `api_health` and `api_error` schemas (and their types in the regenerated `types.ts`), `fastapi`, `uvicorn` and `httpx`, `web/src/api.ts` and the app's custom-point controls.
- vitest raised to 5.1.0. An endless loop in `App.tsx` showed up with it: the timeline window was a new object on every render and an effect dependency, so every worker result started another worker. Fixed by memoising it.
- Merged branches deleted locally and on GitHub. **Not deleted:** `yacin1102-lunar-web-3d`, `-evaluator`, `-stage1`. The 3D view (PR #16, commits `209c7f9`, `2a985b1`) was merged into the stage-1 branch after that branch had gone to `main`, so it never reached `main`. It is kept on those branches to be brought in.

**Data on disk: none.** On 2026-11-15 the removal of the old engine worktree also emptied `python/kernels/` and `python/dem/` in this checkout (most likely through folder links inside the worktree). Nothing committed was affected: `web/public/data/` holds every product the app needs, and `python/data_checksums.json` records all 85 files. The app is independent of the maps. To rebuild products later: `python python/scripts/download_data.py` (verified against the recorded checksums), then `python python/scripts/build_dem_cache.py`. The audit needs only the kernels group: `--group kernels`.

## Status of the engine plan

All engine PRs are merged into `main`: 1 (#4), 2 (#5), 3 (#6, #10), 4 (#7), 5 (#12), 6 (#13), 7 (#17, its API since removed), 8 (#18, #19), 9 (#20), 10 and 11 (#21).

Python environment: `python -m venv .venv`, then `.venv\Scripts\python -m pip install -r python/requirements.txt`.

Test command: `.venv\Scripts\python -m pytest python/tests -v -rs`.

Last result (PR B, 2026-11-15, no maps on disk): Python 187 passed, 66 skipped (real-data tests waiting for kernels or maps), 0 failed, plus the 2 new audit-fixture tests passed. Web: `cd web; npm test`: 62 passed; `npm run build` OK.


## Principle: nothing waits on the download

The full NASA data is 35 GB. The elevation server gives each connection about 0.6 MB/s (measured), so the script downloads four files at a time; the full-resolution maps should take roughly 5 to 6 hours. The work is ordered so that only the last step needs it.

| Arrives | What | Unblocks |
| --- | --- | --- |
| Minutes | SPICE kernels (0.26 GB) | Timetable, position fixtures, event fixtures |
| Within the first hour or so | Coarse LOLA maps (0.9 GB) | The LOLA reader, a first check of the site coordinates |
| Overnight | Full-resolution LOLA maps and error maps (35 GB) | Real skylines, terrain patches, shade grids, final proof |
| Needs no data | Synthetic terrain | Skyline engine, stopping rule, `skyline_err_deg`, line-of-sight check, record writer, live API, web handoff |

## Data products

File names and sizes were read from the NAIF and PGDA listings on 2026-11-14. Each label or GeoTIFF header is read before the file is used, and what it says is written into `python/DATA.md`.

### Download order

The script downloads in this order. Within a group, files are in the order listed.

**Group 1, `kernels`** (`python/kernels/`, from `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/`)

| File | Role | Why this one |
| --- | --- | --- |
| `lsk/naif0012.tls` | Leap seconds (UTC to TDB) | Latest available. |
| `pck/pck00011.tpc` | Body constants (radii) | Latest available. The Sun's radius from it sets the disc size in the fixtures. |
| `fk/satellites/moon_de440_250416.tf` | Defines `MOON_ME` | The frame kernel NAIF pairs with the orientation file below. Its mean-Earth frame is stated to be closely aligned with the DE421 mean-Earth frame that the LOLA maps use. |
| `pck/moon_pa_de440_200625.bpc` (12 MB) | High-accuracy Moon orientation | The current NAIF recommendation, and the only high-accuracy file covering 2026 to 2040 with the current frame kernel. |
| `spk/planets/de440.bsp` (114 MB) | Sun, Earth, Moon positions | The orientation file was produced with DE440, and JPL Horizons (our referee) uses DE440/441, so the three are consistent. |
| `spk/planets/de442.bsp` (114 MB) | Comparison only | The newest ephemeris (Feb 2025). PR 3 measures the difference from DE440 and records it. If it is negligible and its notes pair it with the DE440 orientation file, I will propose switching. |
| `pck/moon_pa_de421_1900-2050.bpc` + `fk/satellites/moon_080317.tf` | Comparison only | The exact frame of the LOLA maps. PR 3 measures the offset between the two `MOON_ME` definitions and puts it in the error budget. |

**Group 2, `coarse`** (`python/dem/`, PGDA product 90, Barker et al. 2023, *Planet. Sci. J.* 4, 183, `https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/`)

Coarse versions of the same product family, same projection and frame, covering the same two footprints as the full set. They are used to develop the reader and are kept afterwards as a cross-check. They add about 0.9 GB to the agreed 35 GB.

| File | Pixel | Covers | Size |
| --- | --- | --- | --- |
| `LDEM_80S_80MPP_ADJ.TIF` | 80 m | pole to 80°S | 181 MB |
| `LDEM_60S_240MPP_ADJ.TIF` | 240 m | to 60°S | 210 MB |
| `LDEM_80S_80MPP_ADJ_ERR.TIF` | 80 m | to 80°S | 244 MB |
| `LDEM_60S_240MPP_ADJ_ERR.TIF` | 240 m | to 60°S | 255 MB |

**Group 3, `full`** (same source). Height maps first, then error maps, so real skylines can start before the error maps finish.

| File | Pixel | Covers | Size | Use |
| --- | --- | --- | --- | --- |
| `LDEM_80S_20MPP_ADJ.TIF` | 20 m | to 80°S (303 km) | 2.6 GB | The whole service region at 20 m |
| `LDEM_83S_10MPP_ADJ.TIF` | 10 m | to 83°S (212 km) | 4.8 GB | Terrain near the site and the near skyline |
| `LDEM_75S_30MPP_ADJ.TIF` | 30 m | to 75°S (455 km) | 2.7 GB | Distant terrain |
| `LDEM_60S_60MPP_ADJ.TIF` | 60 m | to 60°S (910 km) | 2.9 GB | Outer guard, so the search never leaves the data |
| The matching four `..._ADJ_ERR.TIF`, same order | same | same | 19 GB | Published per-pixel height error, feeding `skyline_err_deg` |

**Group 4, `sites5m`** (PGDA product 78, Barker et al. 2021, `https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/`). In the download list since 2026-11-15 (option B: 65 files, 3.05 GB; details in `python/DATA.md`). The directory holds six site folders (Site01, 04, 07, 11, 20, 23). Five of them match curated sites: Site01 is `connecting_ridge`, Site04 `shackleton_rim`, Site07 `peak_near_shackleton` and Site11 `de_gerlache_rim` (stated by Barker et al. 2021), and Site23 is the Malapert massif. Each map's header was read: all five contain their site, at least 6.4 km from the edge. Each folder has, at 5 m pixels, the heights (`_surf`), the total height error (`_toterr`), the slope error (`_slperr`) and 100 error clones (`Clones/`). File sizes were read from the server on 2026-11-15 without downloading: 41 MB each (71 MB for Site23).

**Why four nested maps.** A peak 8 km high is geometrically visible from about 170 km away at ground level, and from over 300 km when the observer also stands on high ground. A site at 85°S can therefore be shadowed by terrain 450 km from the pole.

**Not downloaded:** effective-resolution maps (budget), hillshades, roughness and PSR products. The PGDA PSR map (148 MB) may be added as a referee for the final illumination check.

### The download script

`python/scripts/download_data.py`, driven by a committed list `python/data_files.json` (URL, destination, group, expected size). Checksums are kept in `python/data_checksums.json`.

- **Resumable.** Each file downloads to `name.part` using HTTP range requests and is renamed only when complete and verified. Interrupt it at any time and run the same command again: finished files are skipped, a partial file continues. Every 64 MB the script forces the partial file onto the disk and notes the position; a resume keeps only the bytes up to that position, because after a power cut later bytes may be garbage. A resume also names the file version it started from, so a file replaced on the server restarts instead of being glued onto an old start. Both NASA servers were tested and honour this.
- **Checksums.** Neither NAIF nor PGDA publishes checksums for these files as far as I have found. So on the first download the script checks the byte count against the size the server reports, computes the SHA-256, and writes it into `python/data_checksums.json`, which I then commit. From then on every download and every `--verify` run must match that recorded value. PR 1 states plainly which files had a published checksum to compare against and which did not.
- **Four files at a time.** One connection to the elevation server measured about 0.5 MB/s, which would mean about 19 hours for 35 GB. Four connections measured about 2.5 MB/s in total. Files are still started in list order. `--workers N` changes the number.
- **One copy only.** A second copy started in the same folder refuses to run, because two writers would corrupt a partial file.
- **Progress.** One status line with total progress, speed, time remaining and the percentage of each file in flight. A log is written to `python/dem/download.log`.
- **Stands alone.** It uses only the Python standard library and imports nothing from the engine, so it needs no install and runs while I work.

Command, from the repository root in a separate PowerShell window:

```powershell
python python/scripts/download_data.py
```

Other forms: `python python/scripts/download_data.py --verify` (check what is on disk, download nothing) and `--group kernels` (one group only).

### Service region (proposed)

Latitude at or south of 80°S. Every point then has 20 m data or better underfoot, and at least 600 km of data in every direction. The exact boundary is confirmed from the file headers in PR 8.

## Design decisions that make this possible

### One elevation interface, two backends

Everything downstream talks to one interface, `ElevationSource`: height at a point (metres above the 1737.4 km sphere), the height error at a point, the highest terrain in an area (what the stopping rule needs), pixel size, coverage boundary, and a name for the `dem` field.

- **`SyntheticElevation`**: a sphere plus shapes (walls, cones, ridges, spikes) placed anywhere, including next to the pole. It is sampled onto a pixel grid like a real map, so the engine runs the same code path, and each shape also has a hand-calculated skyline to test against.
- **`LolaElevation`**: the real nested GeoTIFFs. It converts at the edge (stereographic metres, LOLA longitudes, no-data, height reference) and returns the same things.

The skyline engine, stopping rule, `skyline_err_deg`, the independent line-of-sight check, the record writer and the live API are built and tested on `SyntheticElevation` only. The server gets a synthetic mode in which `/api/health` reports that real terrain is not available.

### Tests that need real data

- Marked `@pytest.mark.realdata("kernels")`, `("coarse")`, `("full")` or `("sites5m")`: the group names of `python/data_files.json`.
- A test is skipped only when a file of its group is missing, has the wrong size, or has no recorded checksum. Once the files are there it runs with no change to any command. Re-reading 35 GB on every test run would take minutes, so the full checksum re-check is `download_data.py --verify`, not the test run.
- Every pytest run ends with a table: each skipped test, and the file it is waiting for. **Every time I report test results I will list the skipped tests by name**, not just a count.
- JPL Horizons answers used as references are saved in the repo with the query that produced them, so those tests do not need the network.

### Mock data can never pass as real

Mock files have exactly the contract's names, fields, units, order and binary layout, with values from synthetic terrain. Their `dem` field reads `SYNTHETIC`, site ids start with `mock_`, and the manifest carries a `data_kind` field (`"mock"` or `"real"`). See proposed spec changes.

## Pull requests

Each PR has pytest tests with real output pasted in the description, the list of skipped tests, docstrings, an update to `docs/ARCHITECTURE.md` and to this file, and a `contract-reviewer` pass.

So that review does not hold up the evening, each PR branches from the one before it. Merge them in number order.

**Evening: needs no elevation data**

| # | Pull request | Needs | What it delivers | How it is proven |
| --- | --- | --- | --- | --- |
| 1 | Download script | nothing | `python/scripts/download_data.py`, `python/data_files.json`, `python/DATA.md`, the `realdata` marker and the skipped-test table. **You start the download when this lands.** | Tests against a small local web server: interrupted download resumes from the right byte; a corrupted file is rejected; finished files are skipped; order is kernels, coarse, full. |
| 2 | Web handoff | nothing | `docs/WEB_HANDOFF.md`; JSON Schemas in `docs/schemas/` for every JSON contract and the API; `web/engine/types.ts` generated from the schemas; mock `sites.json`, skylines, terrain, shade and manifest in `web/public/data-mock/`; a validator for JSON and binary files. **The web agent can start here.** | Every mock file passes its schema and the binary size checks; `types.ts` regenerated in the test equals the committed file; mock skylines equal the hand-calculated formulas. |
| 3 | Timetable and fixtures (Contracts 1 and 6) | kernels | `ephem.bin` + `ephem.json`, `altaz.json`, `events.json`, shared SPICE wrapper. The timetable and fixtures are real, and are also copied into `data-mock/` so the web agent has them the same evening. | Directions and alt/az against JPL Horizons; measured interpolation error for candidate `step_s` values and for Float32; DE440 against DE442 and against DE421 `MOON_ME`; event times found two ways agree. |
| 4 | Elevation interface and synthetic terrain | nothing | `ElevationSource`, `SyntheticElevation`, exact spherical geometry helpers. | Heights of each shape against the formula; east is east and north is north, also next to the pole. |
| 5 | Skyline core | PR 4 | The skyline algorithm. Works pixel by pixel instead of along sampled rays, so no peak can fall between samples; each azimuth entry is the maximum over its wedge. Stops in a direction only when the highest remaining terrain provably cannot rise above the current skyline. True local vertical, eye height, observer's own ground excluded. | Hand-calculated skylines: smooth sphere dip, wall due east at azimuth 90, thin spike between azimuths caught, tall far peak behind a low near ridge caught, leaving the data raises an error. |
| 6 | Error bound and independent check | PR 5 | `skyline_err_deg` (height error, horizontal error, interpolation, numerical). A second method: 3D line-of-sight ray casting toward points on the Sun's disc. `docs/ACCURACY.md` started. | The two methods agree within `skyline_err_deg` on synthetic terrain; the bound grows when the input error grows. |
| 7 | Record writer and live API (Contracts 3 and 7) | PR 6 | The shared skyline record writer; FastAPI server with `/api/health`, `/api/skyline`, validation, rounding, cache, CORS, and a synthetic mode the web agent can run tonight. | API response equals the written file for the same point; out-of-region and bad parameters are refused with a clear error; records pass the schema. |

**Evening: in parallel, as data arrives**

| # | Pull request | Needs | What it delivers | How it is proven |
| --- | --- | --- | --- | --- |
| 8 | LOLA reader | coarse maps | `LolaElevation`: projection both ways, pixel registration, no-data, height reference, nesting of maps. Labels of the coarse files recorded in `python/DATA.md`. | On coarse maps: projection round trips, known features at published positions and heights (Shackleton, Malapert massif), a mirrored or rotated read fails. The same tests at full resolution are written now, marked `realdata("full")`, and skipped until morning. |
| 9 | Site list (Contract 2) | coarse maps for the first check | `sites.json` with 10 sites, `python/sites_sources.md` with a source per coordinate, 5 m site files added to the download list. Researched by a background agent while PRs 4 to 7 are built; I check every coordinate and source myself before it goes in. | Schema; every site inside the service region; terrain at each site matches the source's description on the coarse map. The same check at full resolution is marked `realdata("full")`. |
| 10 | Terrain patch, shade grid and manifest builders (Contracts 4, 5, Manifest) | PR 7 | The builders, resumable, run on synthetic terrain. | Centre value 0; curvature drop matches the formula; orientation; shade-grid centre cell equals the site's full skyline within tolerance; normals on a synthetic slope. |

**Morning: needs the full maps**

| # | Pull request | Needs | What it delivers | How it is proven |
| --- | --- | --- | --- | --- |
| 11 | Real products and final proof | full maps | Everything in `web/public/data/` built from real data; `docs/ACCURACY.md` completed. | The morning checklist below, plus percentage of time lit at well-known high-illumination points and no direct sunlight on permanently shadowed floors, compared with published studies. |

I cannot promise how many of PRs 1 to 10 fit in one evening. The order guarantees that whatever is finished is useful on its own, and that the web agent is unblocked after PR 2.

## Morning checklist

Each step is reported with its real output.

1. **Verify the downloads.** `python python/scripts/download_data.py --verify`. Every file present, right size, right SHA-256. If anything is missing, run the download command again and continue with what is there.
2. **Commit the checksums.** The download wrote the SHA-256 of each map into `python/data_checksums.json`. Commit it, so the repository records all 20.
3. **Read every map in full.** Decompress every block of every GeoTIFF once. No published checksum exists to compare the first download against, and a damaged compressed block fails to decompress, so this is the independent check on the first copy.
4. **Read the labels** of the full-resolution files and record them in `python/DATA.md`. Confirm the service region boundary.
5. **Run the real-data tests.** `.venv\Scripts\python -m pytest python/tests -v -rs`. The tests marked `realdata("full")` and `realdata("sites5m")` now run on their own. Report any test still skipped and why.
6. **Build the real products**, in order: skylines for the 10 sites, terrain patches, shade grids, manifest. `python python/scripts/build_products.py` (resumable; the shade grids take longest).
7. **Validate against the schemas.** `python python/scripts/validate_data.py web/public/data`. JSON against `docs/schemas/`, binary sizes against their labels.
8. **Compare with the mocks.** `python python/scripts/compare_with_mock.py`. Same file names, fields, types and layout rules in `data/` and `data-mock/`; values differ by design. Any structural difference is a bug in one of the two.
9. ~~Check the live API on real terrain~~ (API removed 2026-11-15).
10. **Hand over.** Tell the web agent to switch from `data-mock/` to `data/`, update this file, open PR 11.

## Decisions taken

- The plan covers the Python engine only (agreed 2026-11-14).
- Elevation budget is about 35 GB, including the per-pixel error maps (agreed 2026-11-14). The coarse maps add about 0.9 GB.
- DE440 is the build ephemeris and DE442 a measured comparison. This departs from the spec's suggestion of "the latest ephemeris". Measured in PR 3: the two give the same Sun and Earth directions to 0.00000005 degrees over 2026 to 2040, so the choice does not affect any result. DE440 stays, because the Moon orientation file and JPL Horizons are built on it.
- The timetable is hourly, Float32, 115,057 rows (16 Nov 2026 00:00 to 1 Jan 2040 00:00 UTC inclusive), with `LT+S` correction. Measured in PR 3: precise to 0.0000017 degrees for the Sun; see `docs/ACCURACY.md`.
- Disc radii: Sun 695,700 km and Earth 6356.7519 km, from `pck00011.tpc`. The Earth's is its polar radius: from the south pole the upper edge of the Earth's disc is near one of the Earth's poles. This keeps the Earth's edge within about 0.0012 degrees and never too high; the equatorial radius would be up to 0.0032 degrees too high. Raised by the contract review.
- The web side should interpolate the timetable with a cubic through four rows; the formula is in `docs/WEB_HANDOFF.md`.
- Skyline method (PR 5): a proven interval per wedge, from a search that sets areas aside only with proof (see `docs/ARCHITECTURE.md`). Three proven ceilings, the lowest used: per block, per piece from its corners, and per wedge for pieces covering several wedges. Reported skyline = middle of the interval; numerical error = half its width. Ground within 1 m of the point under the eye is not an obstacle. Target half-width 0.0005°, at most 8 cuts per cell.
- Map coverage (PR 5): each map is trusted inside the largest disc around its centre that has all its data; a coarser map takes over outside it. Terrain beyond every map is assumed up to 11,000 m high (above the highest known point on the Moon, about 10,786 m), and a skyline that could be affected by it is refused.
- The download script lives at `python/scripts/download_data.py`.
- One new Python package: `jsonschema`, for validating files against the schemas. numba will be proposed in PR 5 only if timing shows it is needed.

Decided on 2026-11-15 (you asked me to follow my recommendations):

- **Lit, blocked, uncertain:** **lit** when some of the Sun's disc is certainly visible, **blocked** when none of it can be, **uncertain** otherwise; the visible fraction is reported as a range (interpretation 11 below, now approved).
- **Timetable length:** 115,057 hourly rows, so the last row is 1 Jan 2040 00:00 UTC.
- **Service region:** 80°S to the pole. Sites farther north, such as Chandrayaan-3 (about 69°S), are out of scope.
- **Eye at ground level:** `mast_m = 0` is accepted (it was an API setting; the API has since been removed). The answer stays proven; on steep ground it is more often "uncertain".
- **Error model:** keep `K_SIGMA = 3`. Where NASA publishes them (the 5 m site maps, PGDA product 78), use the measured per-pixel slope-error maps instead of the flat 6°, and the published error clones to check the bound (10 per site, option B of PR 9). Elsewhere the general bound of PR 6 applies with 6° and `r0` = 1 pixel diagonal.
- **All contract interpretations below are in force.**

Taken in PRs 10 and 11 (2026-11-15), within your 3-hour budget:

- **Terrain patches:** 241 x 241 samples, 20 m apart (4.8 km), on the 10 m map.
- **Shade grids:** 17 x 17 cells, 300 m apart (the same 4.8 km square), with 1° wedges and Int16 x 0.003°. Each cell's skyline comes from the same proven search at display precision (interval half-width 0.01°). It is turned into the site's frame and carries no map height error, because the shade grid is for display only (spec section 9). The error budget is in `docs/ACCURACY.md`.
- **5 m site maps: downloaded and verified, but not used yet.** The 10 m maps already give proven answers; the 5 m maps would only narrow the bound at 5 sites. Using them (finest map near those sites, measured slope error, clone check) is future work.

Taken in PR 9 (2026-11-15), the site list. You asked me to follow my recommendations.

- **Sites.** The 10 are the connecting ridge, the Shackleton rim, the peak near Shackleton, the de Gerlache rim, the Malapert massif, the IM-2 Athena landing site on Mons Mouton, and the floors of Shackleton, Haworth and Faustini, plus the LCROSS impact point in Cabeus.
  - They contrast five sunlit tops with four shadowed floors, and near-side, limb and far-side longitudes.
  - Every coordinate, its exact source words, and the map check are in `python/sites_sources.md`.
  - The left-out candidates and the reasons are listed there too.
- **5 m site maps: option B** (your choice, 2026-11-15). For the five sites that PGDA product 78 covers, three maps each: heights, height error and slope error. Plus 10 of the 100 published error clones per site: 65 files, 3.05 GB. The bound stays a proven worst case. The clones check it: each clone's skyline must lie inside the bound. This replaces the earlier plan to use all 100 clones to measure the spread.
- **Categories:** `high_illumination`, `landing_site` and `psr`. A category is what the source says. Whether a site is actually lit is answered by the engine, and is compared with published studies in PR 11.
- **Live API values (PR 7):** wedge width default 0.1°, accepted 0.05, 0.1, 0.2, 0.25, 0.5 and 1°; mast default 2 m, accepted 0 to 100 m; custom points rounded to 5 decimals of a degree (at most about 0.6 m along a meridian) and moved no closer to the pole than latitude -89.99999; unknown parameters refused; CORS allows the Vite dev server (`http://localhost:5173`).

## Contract interpretations awaiting approval

PR 2 had to turn the spec's prose into exact schemas (`docs/schemas/`). Where the spec left a choice open, I made one so the web side has something exact to build on. None changes a field the spec names; each is a place where the spec was silent or said two things. They are in force in the schemas, the types and the mock data until you say otherwise.

1. **`sites.json`, `altaz.json` and `events.json` are objects, not bare lists**: `{"version": 1, "sites": [...]}` and `{"version": 1, "cases": [...]}`. The spec asks for "a list" and also for a `version` in every JSON; a bare list cannot carry one.
2. **`dem` is a list of names**, in skylines, terrain labels and shade labels, because several maps can contribute to one product.
3. **A skyline entry covers the wedge centred on its azimuth**: entry `k` is the maximum over azimuths within half a step either side of `k * az_step_deg`.
4. **`size_m = (n - 1) * spacing_m`, with `n` odd**, for terrain patches and shade grids, so the site is exactly the centre sample.
5. **A terrain value is the ground height above the site's level plane, along the site's vertical.** This is how the Moon's curvature is "included": flat ground falls away from the centre.
6. **Shade grid angles and normals are in the patch centre's frame**, not each cell's own. The browser then computes the Sun's direction once per time step for the whole patch.
7. **Manifest fields**: `data_kind`, `built_ms`, `service_region` (`lat_min`, `lat_max`), `files` (`path`, `contract`, `version`, `bytes`) and `sites` (`id`, `has_terrain`, `has_shade_grid`).
8. **API shapes**: `/api/health` returns `ok`, `real_terrain`, `service_region` and the default and accepted `az_step_deg` and `mast_m`. A refused request returns `{"version": 1, "ok": false, "error": {"code", "param", "message"}}` with HTTP 400 or 422. API responses carry `version` like files do.
9. **Fixture cases may carry an optional `name`** saying what the case is meant to expose.
10. **No extra fields**: the schemas reject any field the contract does not list.
11. **Lit, blocked, uncertain (decided 2026-11-15: as proposed here).** The spec says lit is when "the whole relevant part of the disc is above skyline + error". `docs/WEB_HANDOFF.md` proposes: compute the visible fraction of the disc against skyline + error (`f_low`) and against skyline - error (`f_high`); **lit** if `f_low > 0` (some of the disc is certainly visible), **blocked** if `f_high == 0`, **uncertain** otherwise, and report the fraction as the range `f_low` to `f_high`. The stricter reading would call a site lit only when the entire disc is certainly clear, and everything partial "uncertain". This decides what the app says during the hours the Sun is half hidden, so it should be your call.
12. **A curated site's skyline is computed at exactly its `sites.json` coordinates**, with no rounding. Rounding applies only to custom points sent to the API.
13. **Azimuths in the fixtures are in 0 (included) to 360 (excluded).**
14. **Limits the schemas enforce beyond the spec's wording**: exactly 10 sites; `t0_ms` exactly 1794787200000 and the last row at or after 1 Jan 2040; `service_region.lat_max` south of the equator; `category` made of lowercase letters, digits, `_` and `-`; `date_utc` in ISO 8601 form; no NaN or Infinity anywhere.
15. **What `skyline_deg +/- skyline_err_deg` covers.** The spec says each entry is "the true maximum over its whole wedge" and "blocked" is "below skyline - error". A wedge's maximum alone cannot prove "blocked": light can pass through a dip narrower than the wedge (a test shows it). So the interval is made to contain the skyline at every azimuth of the wedge. It still contains the wedge's maximum, as the spec requires, and "lit" and "blocked" both become provable. The reported `skyline_deg` is the middle of that interval, not the maximum itself.

All open choices are now fixed: the category names in PR 9 (`high_illumination`, `landing_site`, `psr`, documented in `python/sites_sources.md`), the API values and rounding in PR 7, the disc radii in PR 3.

## Error model for `skyline_err_deg` (decided 2026-11-15)

PR 6 combines the map's published errors into the bound with three values that are scientific choices, not facts. They decide how often the app says "uncertain". Decision: keep these as the general bound; use measured slope errors and the 100 error clones where NASA publishes them (see "Decisions taken").

| Value | Proposed | What it means |
| --- | --- | --- |
| `K_SIGMA` | 3 | The published height errors are standard deviations; 3 of them make the bound (about 99.7 % for a normal error) |
| `SLOPE_ERROR_DEG` | 6° | Nearby ground comes from the same measurements as the site, so its error relative to the eye cannot grow faster than this slope error over distance. Barker et al. 2021 give a median slope uncertainty of 1.5 to 2.5° for the 5 m maps; 6° is about 3 times 2° |
| near-site zone `r0` | 1 pixel diagonal | Within it, terrain has no error relative to the eye: it is the site's own cell, defined by blending the same pixels |

Measured effect on synthetic terrain: with a 0.5 m map error, the bound averages ±0.15° (largest ±0.38°); with 1 m, ±0.39° (largest ±1.0°). Lower values make more answers definite, but less safely. The horizontal accuracy of the LOLA product will be taken from its paper in PR 8.

## Proposed spec changes

00. **Remove the live API (Contract 7) and custom coordinates (your decision, 2026-11-15).** The app evaluates only the 10 curated sites. Reason: a real-terrain API needs about 32 to 80 GB of maps on a server and minutes of computing per point; without it the app is a static site with no dependence on the maps. `spec/ENGINE_GUIDE.md` is input and is left unchanged; this entry records the departure.

0. **API default `az_step_deg` of 1° for custom points: declined on 2026-11-15** (you asked for the option that balances accuracy and usage). The default stays 0.1°, which is spec-compliant and needs no further work. The web app can ask for 1° as a quick first look. The reasoning, kept for reference: On the real maps an error-bounded answer at 0.1° takes about 4.5 minutes, and at 1° about 25 s. Spec section 7 asks for "a step fine enough that the disc spans several entries", and at 1° the Sun's 0.53° disc spans only one or two. So the default stays 0.1 (reverted after the contract review), and the web app can ask for 1 as a quick first look. If you accept 1° as the default for custom points, the spec sentence should apply to curated sites only. Either way the answer is proven; coarser wedges only mean more "uncertain" hours.

1. **Manifest `data_kind` field** (`"mock"` or `"real"`). The spec lists what the manifest must contain but does not fix its fields, so this is an addition, not a change. It lets the web app refuse to show mock data as a real verdict.
2. Step and Float32: answered in PR 3, **no change proposed**. The hourly Float32 timetable with cubic interpolation is within 0.0000017 degrees for the Sun and 0.0000005 degrees for the Earth. A separate effect built into Contract 1 (the timetable is seen from the Moon's centre and shifted to the site by subtraction) adds 0.000027 degrees for the Earth. Both are far below the 0.01 degree pass mark. Details in `docs/ACCURACY.md`.

## Future work

- Use the 5 m site maps near their five sites: as the finest map, with their measured slope error in the bound, and with the 10 clones per site checking that each clone's skyline lies inside the bound.
- Run the three passes of an error-bounded skyline in parallel processes, about a third of the time.
- A full-resolution shade grid. Each cell is a full search, so a finer grid costs proportionally more computer time. The current one took about 40 minutes on 8 to 13 cores.
- **GPU** (the machine has an NVIDIA RTX 3050 with 6 GB). The proven skyline search branches irregularly and suits the processor. A GPU would pay off for two jobs:
  - a brute-force ray cast for much finer shade grids, checked against the proven search on sample cells;
- Building with fewer workers than cores. 27 processes at once ran out of memory: 48 of 50 GB committed, and heavy paging. 8 workers on 15 GB of RAM was the right setting.

## Open questions

- Mock shade grids exist for 2 of the 10 mock sites, at a small grid size, so the web app meets sites with and without one. Say if the web side needs all 10.
