# Web handoff

Everything the web app (`web/`) needs from the Python engine, and how to use it. Written for whoever builds the web side, person or agent. It describes what exists now; items that are still coming are marked.

## What you get today

| Thing | Where | State |
| --- | --- | --- |
| TypeScript types for every contract | `web/engine/types.ts` | Final. Generated from the schemas; never edit by hand |
| JSON Schemas | `docs/schemas/*.schema.json` | Final |
| Mock data, contract-exact | `web/public/data-mock/` | Ready: sites, skylines, terrain patches, shade grids, manifest |
| Timetable `ephem.bin` + `ephem.json` | `web/public/data-mock/` and later `web/public/data/` | Ready, and **real**: built from the NASA kernels, 16 Nov 2026 to 1 Jan 2040, hourly. Only the terrain in the mock folder is invented |
| Test fixtures `altaz.json`, `events.json` | `web/engine/tests/fixtures/` | Ready, and real: 61 direction cases and 8 event windows |
| Live API | `http://localhost:8000/api/...` | Coming (engine PR 7), with a synthetic-terrain mode first. Response types are final now |
| Real data | `web/public/data/` | Built after the NASA maps finish downloading |

To start in a separate working copy:

```powershell
git worktree add ..\Lunar-web -b web/app feat/timetable
```

## The rules for the web side

1. **Never open a NASA file.** The web app reads only `web/public/data/` (or `data-mock/`) and the live API.
2. **Everything that depends on the chosen time or settings is computed in the browser**: Sun and Earth direction, lit or blocked, events, countdowns, power, battery.
3. **Read the folder's `manifest.json` first.** If `data_kind` is `"mock"`, show a visible "mock data" banner and never present a result as a real verdict.
4. **Never present an uncertain case as yes or no.** See "Lit, blocked or uncertain" below.
5. **If the live API is unreachable, do not fall back to a smooth-Moon verdict.** Show "terrain not included, verdict unavailable".
6. **Show `dem`, `resolution_m` and the uncertainty with every result.**
7. **Read sizes and steps from the labels.** `step_s`, `count`, `az_step_deg`, `n`, `n_az`, `spacing_m` and `skyline_scale` may differ between mock and real data. Do not hard-code them. Do not hard-code site ids or categories either: mock ids all start with `mock_`.

## Shared rules

| Topic | Rule |
| --- | --- |
| Latitude | Degrees, -90 to 90 |
| Longitude | Degrees, east positive, -180 to 180 |
| Azimuth | Degrees from north, clockwise (90 = east) |
| Elevation angle | Degrees above the local level plane; negative = below |
| Heights, surface distances | Metres |
| Sun/Earth positions | Kilometres |
| Times | UTC, milliseconds since 1970-01-01 (what `Date.now()` returns) |
| Height reference | Sphere of radius 1737.4 km (`MOON_RADIUS_M` in `types.ts`) |
| Frame | `MOON_ME`: +z through the north pole, +x through latitude 0, longitude 0 |
| Grids | Rows north to south, columns west to east |
| Binary | Little-endian. Float32 unless stated otherwise |

Every JSON document has an integer `version`. Refuse a file whose version you do not know.

## The files

Folder layout, identical in `data/` and `data-mock/`:

```
manifest.json
ephem.bin  ephem.json
sites.json
skylines/{id}.json
terrain/{id}.bin   terrain/{id}.json          only if has_terrain
shade/{id}.json    shade/{id}_skyline.bin   shade/{id}_normal.bin    only if has_shade_grid
```

### manifest.json (type `Manifest`)

Lists every file with its contract, version and size; says whether the folder is `"mock"` or `"real"`; gives the service region (`lat_min`, `lat_max`); and repeats each site's `has_terrain` and `has_shade_grid`.

### ephem.bin + ephem.json (type `EphemLabel`)

`count` rows of six Float32: `sun_x, sun_y, sun_z, earth_x, earth_y, earth_z`. Each triple is the vector from the Moon's centre to the body, in km, in `MOON_ME`, as apparent positions. Row `i` is at `t0_ms + i * step_s * 1000`.

```ts
const label: EphemLabel = await (await fetch("data/ephem.json")).json();
const rows = new Float32Array(await (await fetch("data/ephem.bin")).arrayBuffer());
// row i: rows[6*i] .. rows[6*i + 5]
```

All browsers that matter are little-endian, so `Float32Array` reads the file directly.

**Interpolate with a cubic through four rows** (4-point Lagrange): for a time between rows `i` and `i+1`, use rows `i-1, i, i+1, i+2`. With `u` = position among those four rows, from 0 at row `i-1` to 3 at row `i+2`:

```
w0 = -(u-1)(u-2)(u-3)/6      w1 =  u(u-2)(u-3)/2
w2 = -u(u-1)(u-3)/2          w3 =  u(u-1)(u-2)/6
value = w0*row[i-1] + w1*row[i] + w2*row[i+1] + w3*row[i+2]      (each of the six columns)
```

In the first and last interval, use the four nearest rows (the first four or the last four) with the same formula. Measured against direct SPICE, this and the rest of the browser method are within 0.000002 degrees for the Sun and 0.00003 degrees for the Earth (`docs/ACCURACY.md`). Straight-line interpolation is about five times worse and saves nothing.

The same steps are written out in Python as `interpolate_rows` and `view_from_rows` in `python/lunar_engine/ephemeris.py`, which the engine's tests run against the fixtures. Use them as a reference implementation.

### sites.json (type `SiteList`)

`{ "version": 1, "sites": [ ... ] }`. Each site has `id`, `name`, `lat`, `lon`, `category`, `has_terrain`, `has_shade_grid`, and optionally `mission`, `date_utc`, `country`, `notes`. This is the only place site coordinates exist.

### skylines/{id}.json and the API response (type `Skyline`)

For each azimuth, the highest elevation angle at which terrain appears from the eye.

- `skyline_deg[k]` belongs to the wedge of azimuths from half a step before to half a step after `k * az_step_deg`. Treat the skyline as a step function. Do not interpolate between entries: interpolation could cut a corner off a peak.
- `skyline_err_deg[k]` is the uncertainty bound of entry `k`, in degrees. The interval `skyline_deg[k] +/- skyline_err_deg[k]` contains the skyline at **every** azimuth of the wedge (both its highest terrain and the lowest the skyline dips to inside the wedge), for any terrain within the map's published error. So a direction above the interval is certainly clear and one below it is certainly blocked, wherever it falls in the wedge.
- `elev_m` is the ground height and `mast_m` the eye height above it. The eye is at `MOON_RADIUS_M + elev_m + mast_m` from the Moon's centre.
- Values can be negative: from a peak the horizon is below the level plane.

To find the entry for an azimuth `az`: `k = Math.round(az / az_step_deg) % skyline_deg.length`.

### terrain/{id}.bin + .json (type `TerrainLabel`), display only

`n * n` Float32 heights in metres. Sample at row `i`, column `j`:

- east = `(j - (n-1)/2) * spacing_m`, north = `((n-1)/2 - i) * spacing_m`, in the site's level plane;
- value = height of the ground above that plane, along the site's vertical. The centre is 0. On flat ground the values fall away from the centre because the Moon curves (1.66 m at 2.4 km), so plotting (east, north, value) gives a true piece of the sphere.

"North" is along the meridian toward the north pole, which at these sites means away from the south pole. Every reported number comes from the skyline, never from this patch.

### shade/{id}.json + two .bin files (type `ShadeLabel`), display only

A skyline and a surface normal for every cell of an `n * n` grid laid out like the terrain patch.

- `_skyline.bin`: Int16, `n * n * n_az` values. Index `(i * n + j) * n_az + a`. Degrees = value * `skyline_scale`. Azimuth `a * az_step_deg`.
- `_normal.bin`: Float32, `n * n * 3` values. Index `(i * n + j) * 3`, components (east, north, up), unit length.
- **All azimuths, elevations and normals are in the frame of the patch centre**, not of each cell. So compute the Sun's azimuth and elevation once per time step, at the site, and use that same direction for every cell. (The Sun's direction differs by less than 0.000002 degrees across a patch.) A cell is lit when the Sun is above that cell's skyline at the Sun's azimuth. For brightness, take the dot product of the cell's normal with the Sun's direction written as (east, north, up).

The shade grid is for the map picture. The site's own lit or blocked answer always comes from its full skyline.

## Computing the Sun's direction at a site

Angles in radians inside the formulas; `R = 1737.4` km.

```
lat, lon in radians;  r = R + (elev_m + mast_m) / 1000        (km)

up    = ( cos(lat)cos(lon),  cos(lat)sin(lon),  sin(lat) )
east  = ( -sin(lon),          cos(lon),          0        )
north = ( -sin(lat)cos(lon), -sin(lat)sin(lon),  cos(lat) )

d = sun_vector - r * up                  (from the eye to the Sun, km)

elevation = asin( dot(d, up) / |d| )
azimuth   = atan2( dot(d, east), dot(d, north) ),  brought into 0..360 degrees
```

Use the full vectors and subtract the site position, as above. The Earth is close enough that skipping this step moves it by up to 0.26 degrees. Use exactly the same formulas for the Earth.

At the pole itself north is undefined; nudge the point off the pole (for example to latitude -89.9999).

Angular radius of a disc: `asin(body_radius / |d|)`, with `|d|` the distance from the eye. Use these radii, which the fixtures were made with: **Sun 695,700 km, Earth 6356.7519 km**. The Earth's value is its polar radius: from the south pole the upper edge of the Earth's disc is near one of the Earth's poles, so this is the closer and the cautious choice (`docs/ACCURACY.md`). The Sun's disc is about 0.53 degrees across and the Earth's about 1.9 degrees.

## Lit, blocked or uncertain

At the pole the Sun skims the skyline for days, so the answer has three values, not two.

The spec words it as: lit when "the whole relevant part of the disc is above skyline + error", blocked when it is "below skyline - error", uncertain in between. That sentence can be read in more than one way, so the reading below is **proposed and awaiting approval** (see `docs/PROGRESS.md`). It answers the spec's question "does sunlight reach this point: yes or no, and how much of the disc clears the terrain?":

1. Compute the fraction of the Sun's disc above the skyline twice: once against `skyline_deg + skyline_err_deg` (pessimistic, gives `f_low`) and once against `skyline_deg - skyline_err_deg` (optimistic, gives `f_high`).
2. **Lit**: `f_low > 0`. Some of the disc is certainly visible.
3. **Blocked**: `f_high == 0`. None of the disc can be visible.
4. **Uncertain**: anything else. Show it as uncertain, with the range `f_low` to `f_high`.

Report the visible fraction as the range `f_low` to `f_high` too. The same test with the Earth's disc gives Earth visibility.

The disc spans several skyline entries (about five at a step of 0.1 degrees). Use every entry whose wedge overlaps the disc's azimuth range, remembering that near elevation `el` a disc of radius `rho` covers `rho / cos(el)` in azimuth.

## The live API

Types: `Skyline`, `ApiHealth`, `ApiError`. Not running yet; it arrives with engine PR 7.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /api/health` | none | `ApiHealth`: `ok`, `real_terrain`, `service_region`, and the accepted and default values of `az_step_deg` and `mast_m` |
| `GET /api/skyline` | `lat`, `lon`, optional `mast_m`, optional `az_step_deg` | `Skyline`, identical in structure to `skylines/{id}.json` |

- Refused requests return `ApiError` with HTTP 400 (bad or missing value) or 422 (point outside the service region). Show `error.message`.
- The response's `lat` and `lon` are the point actually used, after rounding. Use those, not the ones you sent.
- If `real_terrain` is false the server is running on synthetic terrain: treat its answers like mock data.
- Custom points get every number and 2D chart, but no 3D view: there is no terrain or shade endpoint.

## The test fixtures

Types: `AltAzFixture`, `EventsFixture`. Files are in `web/engine/tests/fixtures/`.

- `altaz.json`: `cases` with `lat`, `lon`, `elev_m`, `mast_m`, `t_ms` and the correct `sunEl`, `sunAz`, `earthEl`, `earthAz`, computed with SPICE directly, not from the timetable. Your code, reading the timetable, must agree within **0.01 degrees**. Compare azimuths around the circle (359.99 and 0.01 are 0.02 apart).
- `events.json`: `cases` with a site, a window and the lists `sunrise_ms`, `sunset_ms`, `earthrise_ms`, `earthset_ms`, for a smooth Moon with the eye at ground level (`elev_m` 0, `mast_m` 0). Rise and set are when the **upper edge** of the disc crosses the level horizon: centre elevation + angular radius = 0. Your code must find the same events within **60 seconds**.

Each case has a `name` saying what it is meant to expose; print it when a case fails. The Python version of the browser method passes both fixtures with a wide margin: 0.000026 degrees at worst on directions and 2.7 seconds at worst on events.

Things the event cases will catch: windows run up to 400 days, because 0.1 degrees from the pole the Sun rises about once a year; some windows have one more rise than sets; and near the pole a body can rise and set again within hours, so a scan that steps too coarsely and only looks for sign changes will miss events. Look for turning points of the edge elevation as well as sign changes.

## The mock data

`web/public/data-mock/` holds an invented landscape: a sphere with a few smooth craters and mountains. It exists so that every code path can be built and tested now.

| Site id | What it is for |
| --- | --- |
| `mock_crater_floor` | Walls 15 to 25 degrees high all round: the Sun never clears them. Has a shade grid |
| `mock_crater_rim` | On a rim crest: long lit periods. Has a shade grid, and `mission`, `date_utc`, `country` |
| `mock_peak` | Mountain top: the skyline runs from 2.4 degrees below the level plane to 1.5 above |
| `mock_peak_north_foot` | Earth-facing plain |
| `mock_behind_peak` | A mountain 8 degrees high stands toward the Earth |
| `mock_ridge` | Peak near the pole |
| `mock_second_crater` | Crater floor with walls 7 to 10 degrees high |
| `mock_far_highland` | Far-side facing: the Earth stays near or below the horizon |
| `mock_east_plain` | Flat ground: the skyline is the smooth-sphere horizon, -0.087 degrees for a 2 m mast |
| `mock_near_pole` | 1.5 km from the pole |

Values in the mock: skyline step 0.1 degrees (3600 entries), uncertainty 0.03 degrees everywhere, mast 2 m, terrain patches 121 x 121 at 40 m, shade grids 25 x 25 at 200 m with 72 azimuths. The real data will use different sizes.

The mock is good enough to exercise the app, not to judge it: its skylines come from a simple sampling method, not from the precision engine.

## Checking a data folder

```powershell
.venv\Scripts\python python/scripts/validate_data.py web/public/data-mock
```

This checks every file against its schema, binary sizes against their labels, and the manifest against what is on disk. The same check runs in the engine's tests.

## Choices made here that the spec leaves open

These are interpretations of the spec, made so the web side has something exact to build on. They are listed in `docs/PROGRESS.md` for approval.

1. `sites.json` and the two fixtures are objects with `version` and a list (`sites`, `cases`), because the spec asks both for "a list" and for a `version` in every JSON.
2. `dem` is a list of names, because more than one map can contribute.
3. A skyline entry covers the wedge centred on its azimuth.
4. `size_m = (n - 1) * spacing_m`, with `n` odd so the site is a sample.
5. Shade grid angles and normals are in the patch centre's frame.
6. The manifest's fields, including `data_kind`.
7. The shape of `/api/health` and of error responses.
8. Fixture cases may carry an optional `name`.
9. The reading of lit, blocked and uncertain given above.
10. A curated site's skyline is computed at exactly its `sites.json` coordinates, with no rounding.
11. Azimuths in the fixtures are in 0 (included) to 360 (excluded).
