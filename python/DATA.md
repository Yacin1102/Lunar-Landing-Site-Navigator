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

Label notes, read from every file by `lunar_engine.lola.read_label`, which refuses any file that differs:

| File | Pixels | Pixel size | Extent from the pole |
| --- | --- | --- | --- |
| `LDEM_83S_10MPP_ADJ.TIF` (+ `_ERR`) | 43,280 x 43,280 | 10 m | 216.4 km |
| `LDEM_80S_20MPP_ADJ.TIF` (+ `_ERR`) | 30,400 x 30,400 | 20 m | 304.0 km |
| `LDEM_75S_30MPP_ADJ.TIF` (+ `_ERR`) | 30,496 x 30,496 | 30 m | 457.4 km |
| `LDEM_60S_60MPP_ADJ.TIF` (+ `_ERR`) | 31,040 x 31,040 | 60 m | 931.2 km |

All of them: single band, 32-bit floating point, missing values NaN, south polar stereographic on the 1737.4 km sphere centred on the pole with central meridian 0, square pixels with row 0 at the top, values belonging to pixel areas (`AREA_OR_POINT = Area`). Each error map is on exactly the same grid as its height map.

What the products' paper says (Barker et al. 2023, *Planet. Sci. J.* 4, 183; NTRS preprint 20230014419):

- **Error maps** hold the RMS height uncertainty of each pixel, estimated from ensembles of "clone" maps for 4 representative tiles and converted through each pixel's effective resolution (section 3). They are 1-sigma values, so the engine's bound uses 3 of them.
- **Horizontal accuracy:** "we consider 1.00/1.00/0.15 m as a conservative estimate of the final track geolocation errors" (along-track, cross-track, radial). The engine uses 1 m (`lola.HORIZONTAL_ERROR_M`).
- The maps are in the `MOON_ME` frame of DE421, whose coordinates "have an overall uncertainty of a few meters". That moves the site and its terrain together, so it does not change the skyline.

**Units.** The files carry no unit tag. Their processing history reads `gmt grdmath ... 1000.0 MUL` (a conversion from km), and their recorded value ranges are -7296 to +7026 for heights and 0.019 to 8.96 for errors, which only make sense in metres. `read_label` refuses a file whose recorded range does not look like metres, and any file with a scale or offset.

Checked against published features (`python/tests/test_lola.py`): Shackleton crater on the 80 m map is 4104 m deep from its rim to its floor; Zuber et al. 2012 (*Nature* 486, 378) give a diameter of 21 km and depth/diameter 0.195 +/- 0.025, that is 4100 +/- 500 m. The deepest point lies within the 7 km floor round the gazetteer centre (89.67 S, 129.78 E). At the three places where a mirrored or rotated read would put the crater, the same measurement finds 319 m, 1111 m and -136 m.

The decompressed copies and tables take about 42 GB in `python/dem/cache/` (never committed). Prepare them with `python python/scripts/build_dem_cache.py`.

## Group 4: 5 m site maps (`python/dem/`)

Source: PGDA product 78, `https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/` (Barker et al. 2021, *Planet. Space Sci.* 203, 105119). Files go to `python/dem/sites5m/`, keeping the server's folders. Chosen on 2026-11-15 (option B in `docs/PROGRESS.md`): 65 files, 3.05 GB. Sizes and dates were read from the server on 2026-11-15.

**Why.** The ground close to a site decides its skyline most, and there a small height error moves the skyline most. These maps are twice as fine as the 10 m map and come with a measured slope error, which can replace the general 6° of the error bound.

The 10 error clones per site are not part of the bound. A bound must be a proven worst case, and clones are samples, so they are used to check it: the skyline of every clone must lie inside the bound. Ten per site are enough to catch a bound that is too narrow. The other 90 published clones are not downloaded.

**Which sites.** The server has six site folders. Five of them hold curated sites:

- Barker et al. 2021 state that Sites 1, 4, 7 and 11 are De Rosa's CR1, SR1, SV1 and GR1, and that Sites 1 and 4 are Gläser's C1 and S.
- Site23 is the Malapert massif.
- Site20, the Leibnitz beta plateau, is about 20 km from the IM-2 point, so it is not used.

Each map's header was read on 2026-11-15 without downloading the file. All five use the projection `+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +x_0=0 +y_0=0 +R=1737400 +units=m`, the same as the main maps, with 5 m pixels, float32 values and NaN as no-data. Each contains its site, at least 6.4 km from the map edge:

- Site01, 04, 07 and 11 are 3200 x 3200 pixels (16 km).
- Site23 is 4200 x 4200 pixels (21 km).

The PGDA README says:

- `_surf` is "surface height Z (meters)";
- `_toterr` is "Total Z uncertainty in meters (formally, the RMS error)";
- `_slperr` is "Slope uncertainty in degrees (formally, the RMS error)";
- `Clones/` is "100 clones of LDEM".

These maps are in the Mean Earth frame of DE421, like the main maps.

| Folder | Site | Maps | Clones used | Size |
| --- | --- | --- | --- | --- |
| Site01 | `connecting_ridge` | `Site01_final_adj_5mpp_surf.tif`, `Site01_final_adj_5mpp_toterr.tif`, `Site01_final_adj_5mpp_slperr.tif` | `Site01_final_adj_5mpp_0001_err.tif`, `Site01_final_adj_5mpp_0002_err.tif`, `Site01_final_adj_5mpp_0003_err.tif`, `Site01_final_adj_5mpp_0004_err.tif`, `Site01_final_adj_5mpp_0005_err.tif`, `Site01_final_adj_5mpp_0006_err.tif`, `Site01_final_adj_5mpp_0007_err.tif`, `Site01_final_adj_5mpp_0008_err.tif`, `Site01_final_adj_5mpp_0009_err.tif`, `Site01_final_adj_5mpp_0010_err.tif` | 533 MB |
| Site04 | `shackleton_rim` | `Site04_final_adj_5mpp_surf.tif`, `Site04_final_adj_5mpp_toterr.tif`, `Site04_final_adj_5mpp_slperr.tif` | `Site04_final_adj_5mpp_0001_err.tif`, `Site04_final_adj_5mpp_0002_err.tif`, `Site04_final_adj_5mpp_0003_err.tif`, `Site04_final_adj_5mpp_0004_err.tif`, `Site04_final_adj_5mpp_0005_err.tif`, `Site04_final_adj_5mpp_0006_err.tif`, `Site04_final_adj_5mpp_0007_err.tif`, `Site04_final_adj_5mpp_0008_err.tif`, `Site04_final_adj_5mpp_0009_err.tif`, `Site04_final_adj_5mpp_0010_err.tif` | 533 MB |
| Site07 | `peak_near_shackleton` | `Site07_final_adj_5mpp_surf.tif`, `Site07_final_adj_5mpp_toterr.tif`, `Site07_final_adj_5mpp_slperr.tif` | `Site07_final_adj_5mpp_0001_err.tif`, `Site07_final_adj_5mpp_0002_err.tif`, `Site07_final_adj_5mpp_0003_err.tif`, `Site07_final_adj_5mpp_0004_err.tif`, `Site07_final_adj_5mpp_0005_err.tif`, `Site07_final_adj_5mpp_0006_err.tif`, `Site07_final_adj_5mpp_0007_err.tif`, `Site07_final_adj_5mpp_0008_err.tif`, `Site07_final_adj_5mpp_0009_err.tif`, `Site07_final_adj_5mpp_0010_err.tif` | 533 MB |
| Site11 | `de_gerlache_rim` | `Site11_final_adj_5mpp_surf.tif`, `Site11_final_adj_5mpp_toterr.tif`, `Site11_final_adj_5mpp_slperr.tif` | `Site11_final_adj_5mpp_0001_err.tif`, `Site11_final_adj_5mpp_0002_err.tif`, `Site11_final_adj_5mpp_0003_err.tif`, `Site11_final_adj_5mpp_0004_err.tif`, `Site11_final_adj_5mpp_0005_err.tif`, `Site11_final_adj_5mpp_0006_err.tif`, `Site11_final_adj_5mpp_0007_err.tif`, `Site11_final_adj_5mpp_0008_err.tif`, `Site11_final_adj_5mpp_0009_err.tif`, `Site11_final_adj_5mpp_0010_err.tif` | 533 MB |
| Site23 | `malapert_massif` | `Site23_final_adj_5mpp_surf.tif`, `Site23_final_adj_5mpp_toterr.tif`, `Site23_final_adj_5mpp_slperr.tif` | `Site23_final_adj_5mpp_0001_err.tif`, `Site23_final_adj_5mpp_0002_err.tif`, `Site23_final_adj_5mpp_0003_err.tif`, `Site23_final_adj_5mpp_0004_err.tif`, `Site23_final_adj_5mpp_0005_err.tif`, `Site23_final_adj_5mpp_0006_err.tif`, `Site23_final_adj_5mpp_0007_err.tif`, `Site23_final_adj_5mpp_0008_err.tif`, `Site23_final_adj_5mpp_0009_err.tif`, `Site23_final_adj_5mpp_0010_err.tif` | 918 MB |

## Not downloaded

Effective-resolution maps (disk budget), hillshades, roughness products, point clouds and PSR products. From the 5 m product: the slope maps (`_slp`, computed here from the heights), the count maps (`_ldec`), the point clouds (`.xyzi`), clones 11 to 100, and the Site20 folder.
