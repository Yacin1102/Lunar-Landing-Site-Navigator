# Engine Spec

Nov 14, 2026 · @Yacin

This spec gives the goal, the split between the two halves, and the data contracts between them. Everything else (algorithms, module layout, data products, step sizes, grid sizes, libraries, test strategy, build order) is yours to design. Where a number or method appears below without being marked **contract**, it is a suggestion. If you have a better approach, use it and say why in the pull request.

## 1. Goal and scope

**Scope: the Moon's south polar region only.** Every site, product, test and API request is for the south pole. Nothing is built for the rest of the Moon. You define the exact boundary of the region (the "service region") from the coverage of the high-resolution polar data you choose. Document it, and make sure all curated sites lie inside it.

A web app for lunar mission planners. For any point in the service region and any time, it answers:

- **Does sunlight reach this point: yes or no, and how much of the Sun's disc clears the terrain?** (power)
- Is the Earth visible? (direct-to-Earth communications)
- When is the next sunrise, sunset, Earthrise and Earthset, and how long until each?
- What does that mean for solar power and battery over a mission window?

At the south pole the Sun never rises more than about 1.5 degrees above the level horizon and skims the terrain for days. So the whole value of the app rests on one thing: **the lit / not-lit answer must be scientifically defensible.** Maximum mathematical and scientific precision, above all in the skyline, takes priority over speed, file size and convenience. Every number must trace back to NASA data and be checked against an independent source.

## 2. The split

> If it depends on the time or settings the user chooses, TypeScript (`web/`) does it in the browser. If it depends only on NASA data, Python (`python/`) does it once, ahead of time.

- **Python** reads the NASA data (SPICE kernels, LOLA elevation maps) and writes prepared files. It also runs a small live API for skylines at custom points, because the elevation maps are too large to send to a browser. Python never computes anything for a user-chosen time (events, countdowns, power, battery) and never draws anything.
- **TypeScript** never opens a NASA file. It combines the prepared files with the user's choices, and does so instantly.
- The two halves meet only through the files in `web/public/data/` and the live API. Their formats are the contracts below.

Python has three roles: **Builder** (makes the static files), **Server** (live skylines for custom points), and **Referee** (makes known-correct answers that the TypeScript maths is tested against, and checks Python itself against JPL Horizons and other independent references).

## 3. Inputs: you choose and download them

Download whatever NASA data you need, chosen for maximum precision. Put SPICE kernels in `python/kernels/` and elevation maps in `python/dem/`, and never commit either folder.

- **Elevation maps.** Use the best available LOLA south polar products (for example the PGDA south pole DEMs, which go down to a few metres per pixel near the pole). Make sure coverage reaches as far as any skyline search can go: terrain hundreds of km away can block a low polar Sun. Combine finer and coarser products where needed. Prefer the latest, best-controlled releases, and know each product's published vertical and horizontal accuracy.
- **SPICE kernels.** Use the latest planetary ephemeris, lunar orientation (high-accuracy PCK plus the matching frame kernel for `MOON_ME`), leap seconds, and body constants from NAIF.
- **Reproducibility.** Script or record every download: exact file names, versions, URLs and checksums, kept in the repo (for example `python/DATA.md` plus a download script). Explain in the docs why each product was chosen.
- **Read every label** (`.LBL`, `.xml` or GeoTIFF metadata) before use. It is the authority on projection, scaling, no-data values, height reference and pixel registration.

Useful facts:

- LOLA heights are relative to a sphere of radius 1737.4 km. Polar maps are polar-stereographic projections in metres, and some products use other references; convert to the shared reference.
- SPICE works in radians and in its own time scale (TDB). UTC is the outside world's time.
- The Moon frame must be `MOON_ME` (the frame the LOLA maps use), not `MOON_PA` or `IAU_MOON`.

## 4. Shared rules (contract)

These apply to every file and every API response. Inside the code, use whatever is convenient, but convert at the edges.

| Topic | Rule |
| --- | --- |
| Latitude | Degrees, -90 to 90 (in practice, inside the south polar service region) |
| Longitude | Degrees, east positive, -180 to 180 |
| Azimuth | Degrees from north, clockwise (90 = east). At the pole itself, nudge the point off the pole so that north is defined |
| Elevation angle | Degrees above the local level plane; negative = below |
| Angles in files | Degrees, never radians |
| Ground heights, surface distances | Metres |
| Sun/Earth positions | Kilometres |
| Times | UTC, milliseconds since 1970-01-01 |
| Height reference | Sphere of radius 1737.4 km |
| Moon frame | `MOON_ME` |
| Pixel grids | Rows north to south, columns west to east |
| Binary | Float32 little-endian unless the contract says otherwise; every binary file has a JSON label |
| Versioning | Every JSON has an integer `version`, starting at 1, increased on any format change |

## 5. Contract 1: Sun/Earth timetable

**Files:** `ephem.bin` + `ephem.json`.

Rows of six Float32 numbers, evenly spaced in **UTC**: `sun_x, sun_y, sun_z, earth_x, earth_y, earth_z`. Each is the vector from the Moon's centre to the body in `MOON_ME`, in km, as apparent positions (light time and stellar aberration corrected). The browser subtracts the site position itself, so full vectors (not unit directions) are required.

The timetable **starts on 16 Nov 2026, 00:00 UTC** (`t0_ms` = 1794787200000) and runs to at least 1 Jan 2040. With an hourly step that is 115,056 rows, about 2.8 MB.

Label fields: `version`, `t0_ms`, `step_s`, `count`, `columns` (the six names in order), `units` ("km"), `frame` ("MOON_ME"), `origin` ("MOON"), `aberration` (the SPICE correction string used). Row `i` is at `t0_ms + i * step_s * 1000`. Choose `step_s` so that interpolating between rows adds negligible error compared with the skyline. At the pole a tiny elevation error moves a grazing sunrise by hours, so check this with numbers. If Float32 or the step is not precise enough, propose a change.

## 6. Contract 2: site list

**File:** `sites.json`, a list of **10 curated south polar sites**.

**No coordinates are given to you.** Research them yourself, for example Artemis III candidate regions and their landing sites, Shackleton crater rim and the connecting ridge, CLPS and commercial south polar landing sites, international south polar missions, and well-studied high-illumination points or permanently shadowed regions. Choose 10 that are useful to a south polar mission planner and that include contrasting conditions (high-illumination ridges, crater floors in permanent shadow, near-side and far-side facing longitudes). Take every coordinate from an authoritative source (mission pages, NASA/LROC, peer-reviewed papers) and record that source next to it, for example in `python/sites_sources.md`. A small coordinate error near the pole can move a site from a sunlit ridge into a permanently shadowed crater, so cross-check against the DEM: the site's terrain should match what the source describes.

Fields per site:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Lowercase letters, digits, `_` or `-`; unique; never changes once files are built from it |
| `name` | yes | Display name |
| `lat`, `lon` | yes | By the shared rules |
| `category` | yes | Short lowercase group name for the menu; document the set you use |
| `mission`, `date_utc`, `country`, `notes` | no | Info-card text; `date_utc` is ISO 8601 |
| `has_terrain`, `has_shade_grid` | yes | Set by Python: true only if that site's files exist |

This file is the only place site coordinates exist.

## 7. Contract 3: skyline

**Files:** `skylines/{id}.json` for curated sites; `/api/skyline` returns the identical structure for any point in the service region.

The skyline is, for each azimuth, the highest elevation angle at which terrain appears from the observer's eye. The Sun or Earth is blocked when it is below the skyline in its direction. There is no atmosphere, so this test is exact up to the terrain data. **This is the most important product in the project. Getting it right matters more than anything else.**

| Field | Meaning |
| --- | --- |
| `version` | Format version |
| `lat`, `lon` | The point actually used (after any rounding) |
| `elev_m` | Ground height at the point, from the reference sphere |
| `mast_m` | Eye height above the ground |
| `az_step_deg` | Spacing between azimuths |
| `skyline_deg` | `360 / az_step_deg` angles; entry `k` is at azimuth `k * az_step_deg` |
| `skyline_err_deg` | `360 / az_step_deg` values: the uncertainty bound on each entry, in degrees (see below) |
| `dem` | Elevation map(s) used |
| `resolution_m` | Pixel size of the finest map used near the point |
| `max_reach_km` | Farthest distance any azimuth had to search |

### Proving light reaches the site: yes or no

The app must be able to say "sunlight reaches this point" or "it does not" and stand behind it. That requires:

- **No arbitrary cut-off distance.** The search in each direction may stop only when it is provably impossible for farther terrain to raise the skyline, for example when even the highest terrain in the remaining area could not appear above the current maximum. If the search would leave the area covered by the elevation data, that is an error to handle, not a reason to stop.
- **No missed peaks.** A peak must not fall between sampled azimuths or between sample points along a ray. Each azimuth entry must be the true maximum over its whole wedge and over the whole distance, at the resolution of the data.
- **Exact geometry.** Account for the Moon's curvature with exact spherical (not flat-Earth or small-angle) formulas, the eye height, the observer's true local vertical, and sub-pixel interpolation. Do not count the ground under the observer as an obstacle.
- **A fine azimuth step.** Every site is polar, the Sun is only about 0.53 degrees wide, and it slides along the skyline for days. Use a step fine enough that the disc spans several entries. Choose and document the default and the allowed values for `/api/skyline`.
- **An honest error bound.** `skyline_err_deg` combines the DEM's published vertical and horizontal errors, interpolation and sampling error, and the remaining numerical error. With it, the browser classifies the Sun as **lit** (the whole relevant part of the disc is above skyline + error), **blocked** (below skyline − error), or **uncertain** (in between). The app never presents an uncertain case as a yes or a no.
- **Independent cross-check.** Confirm the skyline method with a second, independent method, for example direct 3D line-of-sight ray casting through the DEM from the site to points on the Sun's disc, at many sites and times. The two must agree within the stated error.

## 8. Contract 4: terrain patch (3D view)

**Files:** `terrain/{id}.bin` + `terrain/{id}.json`. Curated sites only.

A square `n x n` Float32 grid of heights in metres **relative to the site**, centred on the site, in a local east/north frame in metres, with the Moon's curvature included so the patch is a true piece of the sphere. Centre value 0. Rows north to south, columns west to east. (Near the pole "north" is the direction toward the pole along the site's meridian. Document the orientation.)

Label fields: `version`, `lat`, `lon`, `elev_m`, `size_m`, `n`, `spacing_m`, `dem`, `resolution_m`. Choose size and resolution to suit the data.

It is used only for display. Every reported number comes from the skyline.

## 9. Contract 5: shade grid (3D view)

**Files:** `shade/{id}.json`, `shade/{id}_skyline.bin`, `shade/{id}_normal.bin`. Curated sites only.

A skyline for every cell of a square region around the site (same local frame as the terrain patch), plus the surface normal of each cell. The browser turns them into a lit/dark/irradiance map for any time. Sunlight itself is time-dependent, so it is not stored.

- `_skyline.bin`: `n x n x n_az` values, each cell's azimuths together starting at north and going clockwise; stored as int16 multiplied by `skyline_scale` to give degrees.
- `_normal.bin`: `n x n x 3` Float32 unit vectors (east, north, up).
- Label fields: `version`, `center_lat`, `center_lon`, `size_m`, `n`, `spacing_m`, `az_step_deg`, `n_az`, `skyline_scale`, `mast_m`, `dem`, `resolution_m`.

This is the expensive product. Make it resumable. It is for the map display. The site's own lit/blocked answer always comes from its full-precision skyline (Contract 3).

## 10. Contract 6: fixtures for the TypeScript tests

**Folder:** `web/engine/tests/fixtures/`.

- **`altaz.json`**: cases with `lat`, `lon`, `elev_m`, `mast_m`, `t_ms`, `sunEl`, `sunAz`, `earthEl`, `earthAz`, computed directly with SPICE, independently of the timetable. Pass mark for TypeScript: 0.01 degrees. Choose south polar cases that expose sign errors, azimuth near the pole, longitudes all around the pole (near-side and far-side facing), interpolation, timetable edges and height.
- **`events.json`**: per case `lat`, `lon`, `start_ms`, `end_ms`, `sunrise_ms`, `sunset_ms`, `earthrise_ms`, `earthset_ms` (lists), computed for a smooth Moon with no terrain. "Rise" and "set" are when the **upper edge** of the disc crosses the horizon with the eye at ground level. Pass mark: 60 s. Choose windows long enough to cover the slow, grazing events typical of the pole.

## 11. Contract 7: live API

| Endpoint | Request | Response |
| --- | --- | --- |
| `/api/health` | none | `{"ok": true}`, whether real terrain is available, and the service region |
| `/api/skyline` | `lat`, `lon`, optional `mast_m`, optional `az_step_deg` | Exactly Contract 3 |

- A live skyline and a pre-made file for the same point and parameters must be identical, so the Builder and the Server must share the skyline code and the record writing.
- Validate input and refuse bad values with a clear error, including any point outside the south polar service region. Never guess.
- Report the rounded point actually used. Cache answers. Enable CORS for the website's origin.
- The server needs the elevation maps but not SPICE.
- Scope: the API serves skylines only. Custom points get every number and 2D chart, but no 3D view (no terrain or shade endpoint).

If the server is unreachable, the browser must not present a smooth-Moon answer as a lit/blocked verdict at the pole. It shows the result as "terrain not included, verdict unavailable".

## 12. Manifest

`web/public/data/manifest.json`, written last: every file produced, its contract version, build date, the service region, and which sites have terrain and shade files.

## 13. Proof of correctness

Nothing is done until it is proven. You design the tests, but they must establish at least:

- Sun/Earth positions agree with JPL Horizons (validation only, never a runtime dependency) to a few thousandths of a degree where achievable, and the timetable is sane (distances, Earth roughly along +x).
- The elevation reading is right: known south polar features have their published heights, nothing is mirrored, rotated or shifted (check the stereographic projection and pixel registration), and no-data values are handled.
- The skyline is right on synthetic terrain with hand-calculated answers (east really is east, also near the pole), and the stopping rule never misses a feature it should have seen.
- The skyline agrees with an independent line-of-sight method within `skyline_err_deg`.
- Illumination results reproduce published south polar illumination studies (for example the percentage of time lit at well-known high-illumination points, and permanently shadowed crater floors never receiving direct sunlight).
- Live API output equals the pre-made file for curated sites.

Record what you verified, the error budget, and the accuracy limits that remain in `docs/ACCURACY.md`. Show `dem`, `resolution_m` and the uncertainty with every result.

## References

- NAIF generic kernels: https://naif.jpl.nasa.gov/pub/naif/generic_kernels/
- LOLA polar products (PGDA): https://pgda.gsfc.nasa.gov/products/90
- LOLA gridded data: https://imbrium.mit.edu/ and https://ode.rsl.wustl.edu/moon/
- JPL Horizons API: https://ssd-api.jpl.nasa.gov/doc/horizons.html
- Moon Trek tiles (2D map imagery for the web side): https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=moon
