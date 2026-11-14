# Progress

Scope of this plan: the Python engine (`python/`), the files it writes to `web/public/data/`, the fixtures in `web/engine/tests/fixtures/`, and `docs/`. The web app (`web/`) is built by teammates.

## Status

Nothing is built yet. **Next: PR 1 (data download and elevation reading).**

Test command (from PR 1 on): `python -m pytest python/tests -v`. Last result: none yet.

## Data products

All file names and sizes below were read from the NAIF and PGDA listings on 2026-11-14. Checksums are recorded in `python/DATA.md` when `python/download_data.py` first fetches each file (PR 1). Each label or GeoTIFF header is read before the file is used, and what it says is written into `python/DATA.md`.

### SPICE kernels

Stored in `python/kernels/`, from `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/`.

| File | Role | Why this one |
| --- | --- | --- |
| `spk/planets/de440.bsp` (114 MB) | Sun, Earth, Moon positions | The lunar orientation file below was produced with DE440, and JPL Horizons (our referee) uses DE440/441, so the three are consistent. |
| `spk/planets/de442.bsp` (114 MB) | Comparison only | The newest ephemeris (Feb 2025). PR 2 measures the Sun/Earth direction difference from DE440 as seen from the Moon and records it. If its notes say it pairs with the DE440 orientation file and the difference is negligible, I will propose switching to it. |
| `pck/moon_pa_de440_200625.bpc` (12 MB) | High-accuracy Moon orientation | The current NAIF recommendation, and the only high-accuracy file covering 2026 to 2040 with the current frame kernel. |
| `fk/satellites/moon_de440_250416.tf` | Defines `MOON_ME` | The frame kernel NAIF pairs with the file above. Its mean-Earth frame is stated to be closely aligned with the DE421 mean-Earth frame that the LOLA maps use. |
| `pck/moon_pa_de421_1900-2050.bpc` + `fk/satellites/moon_080317.tf` | Comparison only | The exact frame of the LOLA maps. PR 2 measures the offset between the two `MOON_ME` definitions and puts it in the error budget. |
| `lsk/naif0012.tls` | Leap seconds (UTC to TDB) | Latest available. |
| `pck/pck00011.tpc` | Body constants (radii) | Latest available. The Sun's radius from it sets the disc size in the fixtures. |

### Elevation maps

Stored in `python/dem/`. PGDA product 90 (Barker et al. 2023, *Planet. Sci. J.* 4, 183), from `https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/`. These are the latest LOLA south polar maps, with track adjustments applied, in south polar stereographic metres in the DE421 `MOON_ME` frame.

| File | Pixel | Covers | Size | Use |
| --- | --- | --- | --- | --- |
| `LDEM_83S_10MPP_ADJ.TIF` | 10 m | pole to 83°S (212 km) | 4.8 GB | Terrain near the site and the near skyline |
| `LDEM_80S_20MPP_ADJ.TIF` | 20 m | to 80°S (303 km) | 2.6 GB | Next ring out |
| `LDEM_75S_30MPP_ADJ.TIF` | 30 m | to 75°S (455 km) | 2.7 GB | Distant terrain |
| `LDEM_60S_60MPP_ADJ.TIF` | 60 m | to 60°S (910 km) | 2.9 GB | Outer guard, so the search never leaves the data |
| The matching four `..._ADJ_ERR.TIF` | same | same | 19 GB | Published per-pixel height error, feeding `skyline_err_deg` |

Plus PGDA product 78 (Barker et al. 2021), from `https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/`: for each curated site that falls inside one of its 27 regions, `{Site}_final_adj_5mpp_surf.tif` and `{Site}_final_adj_5mpp_toterr.tif` (5 m pixels, median height error 0.3 to 0.5 m). Used for the ground around the observer, where a small height error changes the answer most.

**Why four nested maps.** A peak 8 km high is geometrically visible from about 170 km away at ground level, and from over 300 km when the observer also stands on high ground. A site at 85°S can therefore be shadowed by terrain 450 km from the pole. The search uses the finest map available at each distance and the coarser ones beyond.

**Not downloaded:** the effective-resolution maps (budget), hillshades, roughness and PSR products. The PGDA PSR map (148 MB) may be fetched later as a referee in PR 10.

### Service region (proposed)

Latitude at or south of 80°S. Every point then has 20 m data or better underfoot, and at least 600 km of data in every direction. PR 1 confirms the exact boundary from the file headers and PR 5 confirms that no skyline search reaches the edge.

## Pull requests

Each PR has pytest tests with real output pasted in the description, docstrings, an update to `docs/ARCHITECTURE.md` and to this file, and a `contract-reviewer` pass before it is opened.

| # | Pull request | What it delivers | How it is proven |
| --- | --- | --- | --- |
| 1 | Data download and elevation reading | `python/download_data.py`, `python/DATA.md` (URL, version, checksum, reason, label summary per file). A DEM reader: stereographic projection both ways, pixel registration, no-data, heights converted to the 1737.4 km sphere, longitudes to -180..180, sub-pixel interpolation, and choice of the finest map at a point. | Projection round trips; known features at published positions and heights (Shackleton floor and rim, Malapert massif, the pole); the four maps agree where they overlap; a mirrored or rotated read fails a test. |
| 2 | Sun/Earth timetable (Contract 1) | `ephem.bin` + `ephem.json` from 16 Nov 2026 to 1 Jan 2040. Shared SPICE wrapper (TDB and radians converted at the edge). | Directions against JPL Horizons at many dates; measured interpolation error for candidate `step_s` values and for Float32, compared with the skyline error; DE440 against DE442; DE440 against DE421 `MOON_ME`; sanity (distances, Earth near +x). |
| 3 | Site list (Contract 2) | `sites.json` with 10 sites and `python/sites_sources.md` with a source per coordinate. | Schema test; every site inside the service region; each site's DEM height and slope match what the source describes (ridge, floor, rim). |
| 4 | TypeScript fixtures (Contract 6) | `altaz.json` and `events.json`, computed directly with SPICE, not from the timetable. | Alt/az against Horizons for the same observer; event times found two ways (root finding and dense sampling) agree; cases cover all longitudes, near the pole, timetable edges, and height. |
| 5 | Skyline core (Contract 3 method) | The skyline algorithm and the shared record writer. Works pixel by pixel instead of along sampled rays, so no peak can fall between samples; each azimuth entry is the maximum over its wedge. Stops in a direction only when a table of the highest remaining terrain proves nothing farther can rise above the current skyline. Exact spherical geometry, true local vertical, eye height, observer's own ground excluded. | Synthetic terrain with hand-calculated answers: a wall due east shows at azimuth 90, also next to the pole; a thin spike between azimuths is caught; a tall far peak behind a low near ridge is caught; a smooth sphere gives the exact dip angle; leaving the data raises an error. |
| 6 | Error bound and independent check | `skyline_err_deg` from the per-pixel error maps, horizontal error, interpolation, and numerical error. A second method: 3D line-of-sight ray casting from the site toward points on the Sun's disc. `docs/ACCURACY.md` started. | The two methods agree within `skyline_err_deg` at many sites and times; the bound grows when the input error grows; the error budget is tabulated. |
| 7 | Curated skylines | `skylines/{id}.json` for the 10 sites, with a resumable build command and the chosen default `az_step_deg`. | `check-contracts`; azimuth-step convergence (halving the step changes nothing beyond the bound); `max_reach_km` within coverage. |
| 8 | Live API (Contract 7) | FastAPI server: `/api/health`, `/api/skyline`, input validation, rounding, cache, CORS. Uses the same skyline and record code as the builder, and no SPICE. | API response equals the built file for all 10 sites; out-of-region, bad `az_step_deg` and bad `mast_m` are refused with a clear error. |
| 9 | Terrain patches (Contract 4) | `terrain/{id}.bin` + `.json`; sets `has_terrain`. | Centre value 0; curvature drop at the patch edge matches the formula on a smooth sphere; orientation test with a synthetic feature to the north and to the east. |
| 10 | Shade grids (Contract 5), manifest, final proof | `shade/{id}*` (resumable, int16 skylines and Float32 normals), `manifest.json`, sets `has_shade_grid`. Illumination check against published studies. `docs/ACCURACY.md` completed. | Centre cell matches the site's full skyline within the stated tolerance; normals on a synthetic slope; percentage of time lit at well-known high-illumination points, and no direct sunlight on permanently shadowed floors, compared with published figures; manifest lists every file. |

Order follows `python/README.md`: PRs 2 to 4 unblock the web side early. PR 10 may be split in two if the shade grid is large.

## Decisions taken

- The plan covers the Python engine only (agreed 2026-11-14).
- Elevation budget is about 35 GB, including the per-pixel error maps (agreed 2026-11-14).
- DE440 is the build ephemeris and DE442 a measured comparison (reason in the kernel table). This departs from the spec's suggestion of "the latest ephemeris".
- Python packages stay as in `python/requirements.txt`. A compiled-speed package (numba) will be proposed in PR 5 only if timing shows it is needed.

## Proposed spec changes

None yet. Two items will be answered with numbers in PR 2 and turned into proposals only if the numbers require it:

- whether an hourly step is fine enough for interpolation;
- whether Float32 is precise enough for the Sun vector (it rounds to about 9 km at the Sun's distance, which is about 0.000003 degrees).

## Open questions

1. Contract 1 gives 115,056 hourly rows, which ends one hour before 1 Jan 2040 00:00. To reach "at least 1 Jan 2040" I plan to write 115,057 rows. Say if the count must be exactly 115,056.
2. The site shortlist is decided in PR 3. Sites outside 80°S (for example Chandrayaan-3 at about 69°S) cannot be included under the proposed service region. Candidates: Shackleton rim and the connecting ridge, de Gerlache rim, Malapert massif, Leibnitz beta plateau, Nobile rim, Mons Mouton (IM-2), Malapert A (IM-1, near the region edge), de Gerlache-Kocher massif (far-side facing), and permanently shadowed floors such as Shackleton, Haworth and Cabeus (LCROSS).
