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

NAIF and PGDA do not publish checksums for these files, so there was nothing official to compare the first download against. For every file, the first download was accepted when its byte count equalled the size the server reported on 2026-11-14 (recorded in `data_files.json`), and its SHA-256 was then written to `data_checksums.json`. Every later download and every `--verify` run must reproduce that checksum, so a changed or damaged file is caught. This proves the files stay the same over time; it cannot prove the very first copy was undamaged beyond its size. The first real-data tests (the kernels load in SPICE, each map opens as a raster) cover that for each file as it arrives.

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

Label notes: to be filled in from each file's GeoTIFF header when the elevation reader is built (projection parameters, pixel registration, no-data value, height reference, units).

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
