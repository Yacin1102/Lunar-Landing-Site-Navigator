# Image credits

Every picture in this folder comes from NASA. Each was downloaded once by `web/scripts/fetch-assets.mjs`, converted to a web size and committed here. The app reads only these files and never links to the sources. `assets.json` records, for every file, the source URL, the server's date for the source file, the download date, sizes and SHA-256 checksums.

Nothing was drawn, retouched or generated. The only changes are: resizing, file format, cropping the Sun to its disc and making the outside of the disc transparent.

## Moon

| File | Source | Credit |
| --- | --- | --- |
| `moon/lroc_color_4096.jpg` | CGI Moon Kit, `lroc_color_poles_8k.tif`, https://svs.gsfc.nasa.gov/4720/ | NASA's Scientific Visualization Studio. Colour from the Lunar Reconnaissance Orbiter Camera (LROC) wide-angle mosaic. |
| `moon/ldem_4096_uint16.png` | CGI Moon Kit, `ldem_16_uint.tif`, https://svs.gsfc.nasa.gov/4720/ | NASA's Scientific Visualization Studio. Heights from the Lunar Orbiter Laser Altimeter (LRO/LOLA). |
| `hillshade/south_pole_hillshade.png` and `.json` | `LDEM_80S_80MPP_ADJ_HILL.TIF`, https://pgda.gsfc.nasa.gov/products/90 | NASA/GSFC LRO/LOLA, Planetary Geodesy Data Archive (PGDA). Barker, M. K., et al. (2023), *Planetary Science Journal* 4, 183. |

The elevation map stores unsigned 16-bit counts: height above the 1737.4 km sphere, in metres, is `count × 0.5 − 10000` (stated on the SVS page). Both global maps are plain latitude/longitude with 0° longitude in the middle.

## Sun

| File | Source | Credit |
| --- | --- | --- |
| `sun/sun_hmi_2048.png` | SDO/HMI intensitygram (continuum), plain `HMII` product, https://sdo.gsfc.nasa.gov/assets/img/latest/latest_2048_HMII.jpg | Courtesy of NASA/SDO and the AIA, EVE, and HMI science teams. |

Downloaded on 2026-11-16. The image's own caption reads `SDO/HMI Quick-Look Continuum: 2026.11.16_00:23:15_TAI`. The source address always holds the newest image, so a later download would be a different picture; the script keeps the committed one unless it is told to refresh.

This is the unflattened product: the disc is darker toward its edge (limb darkening), as the Sun really looks from outside an atmosphere. The file is greyscale; the app shows it at full brightness. The caption was removed by the crop.

Credit wording as requested at https://sdo.gsfc.nasa.gov/data/rules.php.

## Earth

| File | Source | Credit |
| --- | --- | --- |
| `earth/bmng_01.jpg` to `earth/bmng_12.jpg` | Blue Marble: Next Generation with topography and bathymetry, one image per month of 2004, 5400 × 2700, https://visibleearth.nasa.gov/collection/1484/blue-marble | NASA Earth Observatory. Blue Marble: Next Generation by Reto Stöckli, NASA Earth Observatory (NASA Goddard Space Flight Center). |

The months are cloud-free composites from 2004. They show the season's snow and vegetation, not the weather on the selected date.
