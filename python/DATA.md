# NASA input data

Every input file the engine reads, where it comes from, and why it was chosen. Nothing here is committed to the repository; `python/kernels/` and `python/dem/` are filled by the download script.

- The list the script follows (URL, destination, size in bytes, server date): [`data_files.json`](data_files.json).
- The SHA-256 checksum of each file: [`data_checksums.json`](data_checksums.json).

## How to get the data

From the repository root:

```powershell
python python/scripts/download_data.py            # everything, in the order below
python python/scripts/download_data.py --verify   # re-check what is on disk
python python/scripts/download_data.py --list     # show the plan
```

The script can be interrupted at any time. Running the same command again skips finished files and continues a partial file from its last byte.

## About the checksums

**State on 2026-11-14: 12 of 20 checksums are recorded (the 8 SPICE kernels and the 4 coarse maps). The 8 full-resolution maps have none yet; theirs are written when the maps finish downloading and are committed then.**

NAIF and PGDA do not publish checksums for these files, so there is nothing official to compare a first download against. The script therefore works like this:

- A first download is accepted when its byte count equals the size the server reported on 2026-11-14 (recorded in `data_files.json`). Its SHA-256 is then written to `data_checksums.json`.
- Every later download and every `--verify` run must reproduce that checksum, so a file that changes or is damaged afterwards is caught.
- To keep a first download from being damaged by an interruption, a resumed download keeps only bytes that were forced onto the disk, and restarts if the server's copy changed in the meantime.

What this cannot prove is that the very first copy matches NASA's, beyond its size. Two independent checks cover that: the kernels are loaded in SPICE and give sane Sun and Earth distances (test `test_build_kernels_load_and_cover_the_timetable`), and every block of every elevation map is decompressed once after download, which fails on a damaged block.

## Group 1: SPICE kernels (`python/kernels/`)

Source: `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/`. All eight were downloaded and checksummed on 2026-11-14.

| File | Server date | Role | Why this one |
| --- | --- | --- | --- |
| `naif0012.tls` | 2016-07-15 | Leap seconds, for UTC to TDB | The latest leap-second file; no leap second has been added since. |
| `pck00011.tpc` | 2022-12-27 | Body radii | The latest generic constants file. Supplies the Sun's radius for the disc size. |
| `moon_de440_250416.tf` | 2025-04-16 | Defines the frame `MOON_ME` | The frame kernel NAIF pairs with the DE440 orientation file. |
| `moon_pa_de440_200625.bpc` | 2021-06-26 | High-accuracy Moon orientation | The current NAIF recommendation and the only high-accuracy orientation covering 2026 to 2040 with the current frame kernel. |
| `de440.bsp` | 2020-12-21 | Sun, Earth, Moon positions (build ephemeris) | The orientation file above was produced with DE440, and JPL Horizons uses DE440/441, so positions, orientation and our referee are consistent. |
| `de442.bsp` | 2025-02-06 | Comparison only | The newest ephemeris. The difference from DE440 is measured with the timetable. |
| `moon_pa_de421_1900-2050.bpc` | 2008-03-19 | Comparison only | The DE421 orientation, the exact frame of the LOLA maps. |
| `moon_080317.tf` | 2013-07-18 | Comparison only | The frame kernel that goes with the DE421 orientation. |

### What the labels say

Read from the comment section of `moon_de440_250416.tf`:

- `MOON_ME` is an alias for `MOON_ME_DE440_ME421`: the DE440 orientation rotated by a constant (67.8526, 78.6944, 0.2785 arcseconds about axes 3, 2, 1) so that it is "closely aligned with the DE421 lunar mean Earth/polar axis frame". This is the frame the LOLA maps use, so `MOON_ME` from this kernel is the right frame for the project.
- NAIF measured the difference between this frame and the true DE421 one: at most 3.07e-7 radians between 2000 and 2040, which is 0.0000176 degrees, or about 53 cm on the Moon's surface. This goes into the error budget. It will be re-measured with the comparison kernels.
- `MOON_ME` differs from `MOON_PA` by about 0.029 degrees (875 m on the surface), which is why the frame must not be confused.

Checked by test `test_build_kernels_load_and_cover_the_timetable`: with the five build kernels loaded, `MOON_ME` exists and the Sun and Earth positions are available at both ends of the timetable (16 Nov 2026 and 1 Jan 2040).

## Group 2: coarse elevation maps (`python/dem/`)

Source: PGDA product 90, `https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/`. Barker et al. 2023, "A New View of the Lunar South Pole from LOLA", *Planetary Science Journal* 4, 183, doi 10.3847/PSJ/acf3e1. Product page: `https://pgda.gsfc.nasa.gov/products/90`.

The product page states: cloud-optimised GeoTIFF, south polar stereographic projection in metres, `MOON_ME` frame of DE421, LOLA tracks adjusted before gridding.

| File | Pixel | Covers | Role |
| --- | --- | --- | --- |
| `LDEM_80S_80MPP_ADJ.TIF` | 80 m | pole to 80°S | Heights |
| `LDEM_60S_240MPP_ADJ.TIF` | 240 m | pole to 60°S | Heights |
| `LDEM_80S_80MPP_ADJ_ERR.TIF` | 80 m | pole to 80°S | Height error per pixel |
| `LDEM_60S_240MPP_ADJ_ERR.TIF` | 240 m | pole to 60°S | Height error per pixel |

Why: they are the same product family as the full-resolution maps (same projection, frame and processing) but 0.9 GB instead of 34 GB, so they arrive early. The elevation reader is developed on them, and they stay as a cross-check afterwards.

First read of the GeoTIFF headers (2026-11-14). The full label notes, with tests, come with the elevation reader.

| Item | What the header says |
| --- | --- |
| Projection | "Moon (2015) - Sphere / Ocentric / South Polar", polar stereographic, metres |
| Reference sphere | Radius 1,737,400 m, the project's height reference |
| Values | Float32. Heights carry the processing note "1000.0 MUL", meaning the source grid in km was converted to metres. Range in the 80 m map: -7295.5 to 7026.3 |
| No data | NaN |
| Pixel registration | `AREA_OR_POINT = Area`, `node_offset = 1`: a value belongs to a pixel's area, not to a grid node |
| Extent | A square, not a circle: the 80°S maps span -304,000 to 304,000 m in x and y (7600 pixels of 80 m); the 60°S maps span -931,200 to 931,200 m (7760 pixels of 240 m). The corners reach beyond the named latitude |
| Error maps | Same grid; values from 0.019 to 8.96 (metres) in the 80 m map |
| Compression | Deflate, so a damaged block fails to decompress |
| Projection parameters | `latitude_of_origin` -90, `central_meridian` 0, no false easting or northing: true scale at the pole, longitude 0 toward +y, 90 east toward +x |
| Layout | Square pixels, no rotation, row 0 at the largest y; the pole is exactly at the middle of the grid, on a pixel corner |

Checked by tests on all four coarse files: the engine's own projection formulas give the same position as the file's declared projection (through the PROJ library) to better than a micrometre (`test_projection_is_the_one_the_map_files_declare`), and the layout is as the table says (`test_map_files_are_laid_out_as_grid_spec_assumes`).

## Group 3: full-resolution elevation maps (`python/dem/`)

Same source and paper as group 2. Height maps are downloaded before error maps.

| File | Pixel | Covers | Role | Why |
| --- | --- | --- | --- | --- |
| `LDEM_80S_20MPP_ADJ.TIF` | 20 m | pole to 80°S (303 km) | Heights | Covers the whole proposed service region. |
| `LDEM_83S_10MPP_ADJ.TIF` | 10 m | pole to 83°S (212 km) | Heights | The finest mosaic; terrain near the site and the near skyline. |
| `LDEM_75S_30MPP_ADJ.TIF` | 30 m | pole to 75°S (455 km) | Heights | Distant terrain that can still block a grazing Sun. |
| `LDEM_60S_60MPP_ADJ.TIF` | 60 m | pole to 60°S (910 km) | Heights | Outer guard so a skyline search never leaves the data. |
| `LDEM_80S_20MPP_ADJ_ERR.TIF` | 20 m | pole to 80°S | Height error per pixel | Feeds `skyline_err_deg`. |
| `LDEM_83S_10MPP_ADJ_ERR.TIF` | 10 m | pole to 83°S | Height error per pixel | Feeds `skyline_err_deg`. |
| `LDEM_75S_30MPP_ADJ_ERR.TIF` | 30 m | pole to 75°S | Height error per pixel | Feeds `skyline_err_deg`. |
| `LDEM_60S_60MPP_ADJ_ERR.TIF` | 60 m | pole to 60°S | Height error per pixel | Feeds `skyline_err_deg`. |

Why four nested maps: a peak 8 km high is geometrically visible from about 170 km away at ground level, and from over 300 km when the observer also stands on high ground. A site at 85°S can therefore be shadowed by terrain 450 km from the pole.

Label notes: to be filled in from each file's GeoTIFF header once downloaded.

## Group 4: 5 m site maps (`python/dem/`)

Source: PGDA product 78, `https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/` (Barker et al. 2021). No files are listed yet. When the 10 sites are chosen, the surface and total-error maps of each site that lies inside one of the product's 27 regions are added to `data_files.json` and to this section.

## Not downloaded

Effective-resolution maps (disk budget), hillshades, roughness products, point clouds and PSR products.
