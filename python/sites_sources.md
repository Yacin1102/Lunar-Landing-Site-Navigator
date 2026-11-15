# Sources of the 10 curated sites

`web/public/data/sites.json` is the only place site coordinates exist (spec section 6). This file records where each coordinate came from, the exact words of the source, and how the map was checked against what the source describes. `python/tests/test_sites.py` confirms that every `Used:` line below equals `sites.json`.

Research date: 2026-11-15.

## Rules applied

- **Copied, never rounded.** Every coordinate is copied from its source. A longitude given on the 0 to 360 east scale is converted to the shared rule's -180 to 180 by subtracting 360. Such a conversion is marked *converted*, and the original value is shown.
- **Frames.** De Rosa et al. (2012), Gläser et al. (2018) and Marshall et al. (2011) state the Mean Earth/Polar Axis frame of DE421, which is the frame of the LOLA maps and of `MOON_ME` here. The USGS Gazetteer states "Planetographic, +East, -180 - 180". On the IAU sphere, planetographic and planetocentric latitudes are the same.
  - [Z12] (`shackleton_floor`) and [LROC] (`mons_mouton_im2`) do not name their frame in the text I read. Both work from LOLA and LRO products, which use the Mean Earth frame. The two lunar frames differ by about 875 m on the ground (`python/DATA.md`), so for these two sites the cross-check is the map check below: the Shackleton point is on the crater floor, and the IM-2 point is on the flat plateau top that LROC describes.
- **Precision.** Gazetteer centres have 2 decimals, which is about 0.3 km along a meridian. That is enough for a point inside a crater floor tens of kilometres wide, but would not be for a ridge, so no ridge or rim point comes from the Gazetteer.

## Categories

The web app groups sites by whatever categories appear. The set used is:

| Category | Meaning |
| --- | --- |
| `high_illumination` | Ridge crests, rims and peaks published as among the most often sunlit points |
| `landing_site` | Where a spacecraft has landed |
| `psr` | Crater floors inside published permanently shadowed regions (PSRs) |

The category is the source's description. Whether each site is actually lit is answered by the engine from the terrain: the illumination check against published studies is part of PR 11.

## Why these 10

- **Lit against dark.** Five published high-illumination points are set against four crater floors in published permanently shadowed regions. Each dark floor is a short distance from a sunlit rim, so the answer changes over short distances.
- **Earth in view or not.**
  - Near-side sites, where Earth is usually up: Malapert (-2°), Haworth (-5°), Mons Mouton (29°) and Cabeus (-49°).
  - Limb sites: de Gerlache (-68°) and Faustini (84°).
  - Far-side sites, where Earth is usually hidden: Peak near Shackleton (124°), Connecting Ridge (-137°) and the Shackleton rim (-156°).
- **Latitude** runs from 84.7°S to 89.8°S, so the Sun's height changes visibly between sites.
- **Real missions.** IM-2 Athena (2025) and LCROSS (2009) give real dates and points for time-specific checks.

**Left out:**

- The Leibnitz beta plateau (De Rosa LP1) is on the same massif as Mons Mouton.
- IM-1 Odysseus (80.13°S) is 4 km inside the service region's edge.
- Shoemaker's floor is the same kind of site as Haworth and Faustini.
- The second Connecting Ridge point (Gläser C2) has no published name match.
- Chandrayaan-3 (about 69°S) is outside the service region.
- Nobile Rim, Amundsen Rim, de Gerlache-Kocher Massif, Faustini Rim A, Peak near Cabeus B, Slater Plain and the Mons Mouton Plateau region: I found no authoritative point coordinate for any of them. The NASA Artemis III region announcements give names only.

## References

- **[DR12]** De Rosa et al. 2012, "Characterisation of potential landing sites for the European Space Agency's Lunar Lander project", *Planet. Space Sci.* 74, 224-246, doi:10.1016/j.pss.2012.08.002. Text read at https://arxiv.org/pdf/1208.5587. Table 2: "Coordinates of the centre point of the Regions of Interest, in the Mean Earth/Polar Axis (ME/PA) reference system (DE421, Williams et al., 2008)".
- **[G18]** Gläser et al. 2018, "Illumination conditions at the lunar poles: Implications for future exploration", *Planet. Space Sci.* 162, 170-178, doi:10.1016/j.pss.2017.07.006. Accepted manuscript: https://ntrs.nasa.gov/api/citations/20170007365/downloads/20170007365.pdf. Table 1: surface level, 20-year average, 20 m/pixel LOLA terrain, longitudes 0 to 360 east.
- **[B21]** Barker et al. 2021, *Planet. Space Sci.* 203, 105119 (PGDA product 78): "Sites 1, 4, 7, and 11 correspond, respectively, to CR1, SR1, SV1, and GR1 of De Rosa et al. (2012) and Sites 1 and 4 correspond, respectively, to C1 and S of Gläser et al. (2018)."
- **[Z12]** Zuber et al. 2012, "Constraints on the volatile distribution within Shackleton crater at the lunar south pole", *Nature* 486, 378-381. Accepted manuscript: https://ntrs.nasa.gov/api/citations/20120013758/downloads/20120013758.pdf.
- **[M11]** Marshall et al. 2011, "Locating the LCROSS Impact Craters", *Space Sci. Rev.*, doi:10.1007/s11214-011-9765-0. Preprint: https://arxiv.org/abs/1103.1687.
- **[T15]** Tye et al. 2015, "The age of lunar south circumpolar craters Haworth, Shoemaker, Faustini, and Shackleton", *Icarus* 255, doi:10.1016/j.icarus.2015.03.016 (https://ntrs.nasa.gov/citations/20150006822). The abstract says: "The interiors of the lunar south circumpolar craters Haworth, Shoemaker, Faustini, and Shackleton contain permanently shadowed regions (PSRs)".
- **[Gaz]** USGS Gazetteer of Planetary Nomenclature, `https://planetarynames.wr.usgs.gov/Feature/<number>`.
- **[LROC]** Lunar Reconnaissance Orbiter Camera image releases, `https://lroc.im-ldi.com/images/<number>`.
- **[SVS]** NASA Scientific Visualization Studio: https://svs.gsfc.nasa.gov/5013 (Artemis III candidate regions, 2022). NASA, "NASA Provides Update on Artemis III Moon Landing Regions", 28 Oct 2024: https://www.nasa.gov/?p=748006 (9 regions).

## Check against the map

From `python python/scripts/check_sites.py`, on the 10 m map (`LDEM_83S_10MPP_ADJ`, Barker et al. 2023), on 2026-11-15:

- **Height** is from the 1737.4 km sphere.
- **Error** is the map's published height error at the point.
- **Slope** is measured across 20 m on each side.
- **The disc columns** give heights relative to the site: the highest, lowest and median ground within that distance.

| id | map | height m | error m | slope deg | 0.2 km max / median | 1 km max / median | 3 km max / min / median | 10 km max / min / median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| connecting_ridge | LDEM_83S_10MPP_ADJ | 1957.5 | 0.22 | 0.9 | +0 / -5 | +2 / -40 | +2 / -797 / -249 | +2 / -2294 / -817 |
| shackleton_rim | LDEM_83S_10MPP_ADJ | 1737.3 | 0.17 | 1.3 | +1 / -10 | +1 / -101 | +1 / -1832 / -433 | +211 / -4584 / -1009 |
| peak_near_shackleton | LDEM_83S_10MPP_ADJ | 1598.8 | 0.40 | 4.5 | +16 / -4 | +50 / -14 | +50 / -719 / -180 | +50 / -2246 / -763 |
| de_gerlache_rim | LDEM_83S_10MPP_ADJ | 1779.0 | 0.18 | 2.8 | +8 / -1 | +37 / -38 | +37 / -1009 / -339 | +37 / -2636 / -1255 |
| malapert_massif | LDEM_83S_10MPP_ADJ | 4970.2 | 0.21 | 7.1 | +9 / -2 | +23 / -53 | +23 / -846 / -245 | +203 / -3956 / -1298 |
| mons_mouton_im2 | LDEM_83S_10MPP_ADJ | 5321.7 | 0.44 | 3.1 | +8 / -2 | +37 / -10 | +37 / -269 / -98 | +213 / -712 / -171 |
| shackleton_floor | LDEM_83S_10MPP_ADJ | -2769.8 | 0.20 | 1.4 | +18 / +1 | +115 / -2 | +308 / -103 / +27 | +4143 / -103 / +2196 |
| haworth_floor | LDEM_83S_10MPP_ADJ | -3315.7 | 0.51 | 10.4 | +34 / +7 | +73 / +5 | +90 / -199 / -52 | +598 / -706 / -62 |
| faustini_floor | LDEM_83S_10MPP_ADJ | -2755.8 | 0.24 | 8.3 | +9 / -2 | +68 / +17 | +108 / -148 / +38 | +653 / -237 / +57 |
| cabeus_lcross | LDEM_83S_10MPP_ADJ | -3834.1 | 0.32 | 1.3 | +9 / +3 | +26 / +5 | +219 / -118 / +25 | +2025 / -198 / +210 |

The highest ground within 0.6 crater diameters of each floor site, read from a coarser map so the disc fits in memory:

| Site | Distance and map | Highest ground |
| --- | --- | --- |
| Shackleton | 12.6 km, 10 m map | +4508 m |
| Haworth | 30.9 km, 20 m map | +5808 m |
| Faustini | 25.5 km, 20 m map | +3932 m |
| Cabeus | 60.3 km, 60 m map | +9523 m |

**Reading:**

- **The five ridge, rim and peak points are tops.** Each is within 50 m of the highest ground within 1 km, and 180 to 435 m above the median ground within 3 km. Gläser's ridge and rim points are within 2 m of the highest ground within 3 km.
- **The IM-2 point is on a flat, high plateau.** It is at 5,322 m with a 3° slope. The crater about 20 m across that the lander lies in is too small for a 10 m map.
- **The four floors are bottoms.** Each is within 200 m of the lowest ground within 3 km, with a rim 3.9 to 9.5 km higher around it. Shackleton's floor lies 4.1 km below the highest ground within 10 km. Zuber's depth-to-diameter ratio of 0.195 ± 0.025 for a crater 21 km across gives 4.1 ± 0.5 km. The 8 to 10° slopes at the Haworth and Faustini centres are hummocky floor terrain: those centres are 0.7 km and 0.2 km above the lowest ground within 10 km.
- **The LCROSS point is at -3,834 m on the map.** Marshall measured -3,825 ± 10 m. The 9 m difference is within one standard deviation.

`python/tests/test_sites.py` turns these readings into pass/fail checks.

---

## `connecting_ridge` (Connecting Ridge)

**Used:** latitude -89.4505, longitude -137.16

**Source:** [G18] Table 1, row "Connecting Ridge, C1 / This study: -89.4505 | 222.84 | 76.0 | 81.3 | 268" (latitude, longitude 0 to 360 east, maximum average illumination %, solar visibility %, maximum time in shadow in hours). Longitude *converted* from 222.84 E.

- **Other published values:**
  - Mazarico et al. 2011, via G18 Table 1: -89.45, 222.69 (-137.31).
  - Speyerer & Robinson 2013, via G18: -89.418, 221.3 (-138.7).
  - [DR12] Table 2, "Connecting Ridge | CR1 | -89.4679 | -137.411". This is the centre of a region of interest.
  - The sources differ by up to about 1.5 km. Each picks the best pixel of a different terrain model.
- **Terrain described:** a narrow ridge crest. G18 says the lit locations are "only twenty to forty meters wide".
- **Mission:** an Artemis III candidate region, "Connecting Ridge", on the 2022 list [SVS] but not on the 2024 list. [B21] Site01.

## `shackleton_rim` (Shackleton crater rim)

**Used:** latitude -89.7849, longitude -156.03

**Source:** [G18] Table 1, row "Shackleton, S / This study: -89.7849 | 203.97 | 81.0 | 85.5 | 221". Longitude *converted* from 203.97 E.

- **Other published values:**
  - Mazarico 2011, via G18: -89.78, 204.27 (-155.73).
  - Speyerer & Robinson 2013, via G18: -89.740, 201.2 (-158.8).
  - [DR12] "Shackleton Rim | SR1 | -89.7755 | -156.448".
- **Terrain described:** the crest of the crater rim. [B21] Site04.

## `peak_near_shackleton` (Peak near Shackleton)

**Used:** latitude -88.8247, longitude 124.1359

**Source:** [DR12] Table 2, "Shackleton Vicinity | SV1 | -88.8247 | 124.1359 | 29.48 | -20". [B21] confirms that Site07 is SV1: "Site 7 is an isolated peak near Shackleton on the far side".

- **Terrain described:** the summit of an isolated peak.
- **Mission:** an Artemis III candidate region, "Peak Near Shackleton", on the 2022 list [SVS].

## `de_gerlache_rim` (de Gerlache crater rim)

**Used:** latitude -88.6952, longitude -68.2846

**Source:** [DR12] Table 2, "de Gerlache Rim | GR1 | -88.6952 | -68.2846 | -36.76 | 14.64". [B21] confirms that Site11 is GR1: "Site 11 is on the rim of de Gerlache".

- **Terrain described:** the crest of the crater rim.
- **Mission:** NASA lists "de Gerlache Rim 1" and "de Gerlache Rim 2" among the Artemis III regions, but publishes no point, so the site is not tied to either in `sites.json`.

## `malapert_massif` (Malapert Massif)

**Used:** latitude -85.9756, longitude -2.11241

**Source:** [DR12] Table 2, "Malapert Peak | MP1 | -85.9756 | -2.11241 | -4.48 | 121.8".

- **Other values:**
  - [DR12] MP2: -86.0265, 2.757964.
  - [Gaz] Mons Malapert (Feature 16338) has its centre at -85.98, -1.67. That is the centre of a 67 km massif, not a lit point.
- **Terrain described:** high on a massif.
- **Mission:** an Artemis III candidate region, "Malapert Massif", on both the 2022 and 2024 lists [SVS].

## `mons_mouton_im2` (IM-2 Athena landing site, Mons Mouton)

**Used:** latitude -84.7906, longitude 29.1957

**Source:** [LROC] image 1408, "IM-2 Athena Seen Obliquely", 10 March 2025: the lander "ended up on its side within a 20-meter diameter crater (84.7906° S, 29.1957° E)".

- **Other values:**
  - The intended target, from [LROC] image 1401 (26 Feb 2025): "(-84.78°, 29.13°E) is 160 kilometers from the south pole".
  - [Gaz] Mons Mouton (Feature 16070) has its centre at -84.60, 31.00.
- **Terrain described:** the plateau top of Mons Mouton. NASA SVS 5074 (https://svs.gsfc.nasa.gov/5074) notes that the mountain is "sometimes known informally as Leibnitz Beta".
- **Mission:** Intuitive Machines IM-2 (Nova-C lander "Athena"), part of NASA's Commercial Lunar Payload Services, landed on 2025-03-06. Only the day is given: the LROC pages give no touchdown time.

## `shackleton_floor` (Shackleton crater floor)

**Used:** latitude -89.655, longitude 129.174

**Source:** [Z12] Table 1, "Parameters describing Shackleton crater": "latitude of centre of rim (degrees) -89.655" and "longitude of centre of rim (degrees) 129.174".

- **Other values:** [Gaz] Shackleton (Feature 5450) has its centre at -89.67, 129.78 and a diameter of 20.92 km.
- **Terrain described:** a bowl-shaped crater whose floor is about 6.6 km across [Z12], so the centre of the rim lies on the floor.
- **Permanent shadow:** [T15].

## `haworth_floor` (Haworth crater floor)

**Used:** latitude -87.45, longitude -5.17

**Source:** [Gaz] Haworth (Feature 14502): "Center Latitude -87.45", "Center Longitude -5.17", diameter 51.42 km.

- **Terrain described:** the centre of a crater 51 km across, on its floor. The point is the crater's centre, not a mapped shadow point.
- **Permanent shadow:** [T15].
- **Mission:** "Haworth" is an Artemis III candidate region on both the 2022 and 2024 lists, but NASA gives no point and the region is presumably on the rim. So no mission is attached to this floor site.

## `faustini_floor` (Faustini crater floor)

**Used:** latitude -87.18, longitude 84.31

**Source:** [Gaz] Faustini (Feature 1919): centre -87.18, 84.31, diameter 42.48 km.

- **Terrain described:** the centre of a crater 42 km across, on its floor.
- **Permanent shadow:** [T15].

## `cabeus_lcross` (LCROSS impact site, Cabeus crater)

**Used:** latitude -84.6796, longitude -48.7093

**Source:** [M11], abstract: "a weighted average Centaur impact location of -84.6796°, -48.7093°, with a 1σ uncertainty of 115 m along latitude, and 44 m along longitude, just 146 m from the target impact site". It gives the altitude as "-3,825 ± 10" m (on R = 1737.4 km, "Mean Earth, selenocentric coordinates").

- **Time:** 2009-10-09T11:31:19.506Z ([M11] Table 1, "Time (UTC) 11:31:19.506").
- **Permanent shadow:** [M11] says LCROSS "impacted a spent Centaur rocket stage into a permanently shadowed region near the lunar south pole".
- **Other values:**
  - The target was -84.675, -48.725 ([M11] Table 3).
  - [Gaz] Cabeus (Feature 953) has its centre at -85.33, -42.13 and a diameter of 100.58 km.
- **Mission:** LCROSS (NASA), the impact of the Centaur upper stage.
