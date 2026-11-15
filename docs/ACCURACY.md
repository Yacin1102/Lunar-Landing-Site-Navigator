# Accuracy

What has been verified, against what, and the error that remains. Every figure here is printed by a test in `python/tests/`; the test is named so the figure can be reproduced. This page grows with each pull request. The skyline, which will dominate the error budget, is not built yet.

## Sun and Earth directions

Verified in `python/tests/test_ephemeris.py`.

### Against JPL Horizons

JPL Horizons is NASA's online ephemeris service and shares no code with this project. It was asked for the apparent azimuth and elevation of the Sun and the Earth from five lunar surface sites (latitudes 80°S to 89.9°S, all sides of the pole, heights from 4 km below to 5 km above the reference sphere) at six dates from November 2026 to 1 January 2040. Its replies are saved with the exact queries in `python/tests/data/horizons_altaz.json`. Horizons states that it uses the Moon's `MEAN_ME` high-precision orientation, the frame this project uses.

| Compared with Horizons, 60 directions | Worst azimuth difference | Worst elevation difference | Test |
| --- | --- | --- | --- |
| Engine, computed directly for the site | 0.00000054° | 0.00000007° | `test_directions_agree_with_jpl_horizons` |
| Browser method (timetable, interpolation, shift to the site) | 0.000026° (either angle) | | `test_browser_method_agrees_with_jpl_horizons` |

The spec asks for agreement "to a few thousandths of a degree where achievable". The direct calculation agrees about ten thousand times better than that, which also confirms the frame, the east/north/up conventions and the time conversion.

### Error budget for a direction computed in the browser

| Source | Sun | Earth | How it was measured |
| --- | --- | --- | --- |
| Timetable: hourly rows, stored as Float32, cubic interpolation | 0.0000017° | 0.0000005° | 500 random sites and times against the exact Moon-centre vector (`test_interpolating_the_timetable_adds_negligible_error`) |
| Shifting from the Moon's centre to the site by subtracting the site position | 0.00000016° | 0.000027° | Same test, against a direct calculation for the site |
| Choice of ephemeris, DE440 or DE442 | 0.00000001° | 0.00000005° | `test_de442_gives_the_same_directions_as_de440` |
| Total for the browser method | 0.0000018° | 0.000027° | Same test as the first two rows |

For scale: the Sun's disc is 0.53° wide and the TypeScript pass mark is 0.01°.

The second row is built into Contract 1. The timetable holds what is seen from the Moon's centre, with the light-time and aberration corrections worked out for the centre; the browser then shifts the vector to the site by subtraction. With no corrections at all the shift is exact (the two routes agree to rounding), and with the corrections they differ by up to 0.000026° for the Earth (`test_the_shift_to_the_site_is_exact_without_light_corrections`). It is 370 times smaller than the pass mark and far below any skyline uncertainty, so no change to the contract is proposed.

**Straight-line interpolation** between rows instead of the cubic gives 0.00012° in total. That is still small, but the cubic costs nothing and is the recommended method.

**Conclusion on the two open questions of the plan:** an hourly step and Float32 storage are both precise enough. No spec change is proposed.

### Frame of the timetable against the frame of the elevation maps

The LOLA maps are in the `MOON_ME` frame of the older DE421 ephemeris. The timetable uses `MOON_ME` from the current DE440 kernels, which NAIF built to be closely aligned with it. Measured over 2026 to 2040 at 2000 moments (`test_moon_me_is_within_a_metre_of_the_frame_of_the_lola_maps`): the two frames differ by at most 3.06e-7 radians, which is 0.0000175°, or 0.53 m on the Moon's surface. NAIF's own figure for 2000 to 2040 is 3.07e-7 radians.

This is an offset between where the timetable places the Sun and where the maps place the terrain. It is ten times smaller than the finest map pixel is wide and will be carried into the skyline error budget as 0.0000175°.

## Rise and set times (smooth Moon)

The reference events in `events.json` are for a smooth sphere with the eye at ground level, the upper edge of the disc crossing the level horizon. Disc radii: Sun 695,700 km, Earth 6356.7519 km (its polar radius), both from `pck00011.tpc`.

**The Earth's disc is treated as a circle, and this is the largest known error in the Earth's edge.** The Earth is flattened by 21 km. Seen from the Moon's south pole, the upper edge of its disc is near one of the Earth's poles, where the true limb is between 6356.75 km and about 6365 km from the centre depending on the date (estimated from the Earth's shape and the tilt between the two bodies' axes; not measured by a test). Using the polar radius therefore places the upper edge at most about 0.0012° too low and never too high: the app will not say the Earth's edge is visible when it is not. The equatorial radius would have placed it up to 0.0032° too high. This is about 45 times larger than the 0.000027° above, and still small beside the skyline uncertainty. It affects only the Earth's edge, not the Sun or the Earth's centre.

| Check | Result | Test |
| --- | --- | --- |
| Each of the 110 stored events is a real crossing: the upper edge is on opposite sides of the horizon one second before and one second after | All 110 | `test_every_fixture_event_is_a_real_crossing_of_the_upper_edge` |
| A finer first scan finds the same events to the millisecond | Same, in the four windows rescanned: two ordinary ones every 2 minutes instead of 10, and the two beside the pole every 5 minutes (the 400-day one for the Sun only) | `test_a_finer_scan_finds_the_same_events` |
| The browser method, from the timetable, finds the same events | Worst timing difference 2.7 s (pass mark 60 s), on an Earth event at 80°S | `test_browser_method_passes_the_events_fixture_with_a_wide_margin` |
| A graze that pokes above the horizon for under a minute between scan points is found, also in the first and last scan interval of a window | Found | `test_event_finder_catches_a_graze_between_scan_points`, `test_event_finder_catches_a_graze_right_at_the_edge_of_the_window` |

The four windows not rescanned (both limbs, the edge of the service region, the end of the timetable) rely on the event finder's own turning-point search.

**Limit that remains.** At the pole an event can hang on a hair: a turning point of the Sun's edge can pass within thousandths of a degree of the horizon. The fixture builder refuses any window where that margin is under 0.002° (`test_fixture_builder_refuses_a_window_where_an_event_hangs_on_a_hair`). The closest in the current fixture is 0.0031°, for the Sun 0.5° from the pole (printed by `test_a_finer_scan_finds_the_same_events`). On real terrain this fragility is what the lit / blocked / uncertain classification exists for.

## Skyline method (synthetic terrain)

Verified in `python/tests/test_skyline.py`, without any real map. The engine returns, for every wedge, a lower limit (the elevation of a real terrain point in the wedge) and a proven upper limit. Each test checks that the true answer lies between them.

| Check | Result |
| --- | --- |
| Smooth sphere, 2 m and 10 m mast: the horizon is `acos(R / (R + h))` below level (0.0869° and 0.1944°) | Inside the interval in all 3600 directions; interval at most ±0.0000008° (2 m) and ±0.00000007° (10 m) |
| Full ring wall 3 km away, 300 m high | Between the two hand-calculated angles for the wall's near face, one pixel diagonal either side (5.5° to 5.7°) |
| Wall sectors due east, north, south and west, 1 km from the pole and at 85°S | Raised in exactly the wedges inside the sector, the smooth horizon elsewhere |
| A 300 m spike 10 km away whose whole footprint lies between two wedge centre lines | Found, at 1.542° as calculated by hand. Rays along the wedge centre lines provably see only flat ground there |
| An 800 m peak 9 km away behind a 60 m ridge 1.5 km away (2.2°) | The peak is reported (4.92°), not the ridge |
| A peak 12 km away present only in the coarse map of two nested maps | Found, at the hand-calculated angle |
| A 100 m mast whose smooth horizon (18.6 km) lies beyond a 12 km map | Refused with `CoverageError`, no cut-off. With a 25 km map: the exact 0.6147° dip |
| Unmapped terrain left at the real-data assumption (up to 11,000 m) | Refused when it could matter |
| 25 random cones within 6 km; brute force with 16 points in each of 40,000 cells (2.5 million points) | No point rises above the upper limit of its wedge. Closest: 0.000000001° below it, which is the rounding margin added to every ceiling |
| Site 100 m up an 18° slope (the flank of a 1000 m cone), 2 m mast; brute force with 9 points in each of a million cells (9 million points) | No point above the upper limit; the uphill skyline is the cone's top at the hand-calculated angle |

**Numerical error.** Half the interval width is the numerical part of the error bound. Measured:

| World | Mean half-width | Largest half-width |
| --- | --- | --- |
| Smooth sphere, 2 m mast | | 0.0000008° |
| 25 cones within 6 km, 2 m mast | 0.00014° | 0.0011° |
| 18° slope, 2 m mast | 0.00014° | 0.005° |

How the slope case was fixed. The contract review found that on an 18° slope the interval reached ±0.027°. Two causes, both now addressed with proven ceilings (see `docs/ARCHITECTURE.md`):

- the first ceiling pairs a piece's highest point with its nearest distance, which is loose on a slope facing the eye; pieces of cells now also get a ceiling from their four corner points;
- a piece covering several wedges raised all of their ceilings with its highest part, which matters most along the slope's contour; such pieces now get a separate ceiling per wedge.

**Limit that remains: an eye at ground level on a steep slope.** With `mast_m = 0` on the same slope, the interval averages ±0.016° and reaches ±0.08°. With the eye exactly on the ground, the ground at the observer's feet rises at the skyline's own angle in every direction, all the way in to the 1 m excluded circle. Pieces there are too close to resolve to 0.1° wedges. The result is still proven, only wider. Whether the live API should accept `mast_m = 0` is an open question for PR 7.

A rounding margin of 0.000000001° is added to every ceiling, so that floating-point rounding cannot place a terrain point above it.

## Error bound and independent check (synthetic terrain)

Verified in `python/tests/test_uncertainty.py`.

**What the interval means.** For every wedge, `skyline_deg +/- skyline_err_deg` contains the skyline at every single azimuth of the wedge, for any terrain within the error model. A direction above the interval is certainly clear; one below it is certainly blocked.

This goes further than the wedge's highest terrain. A wedge's highest terrain proves "clear" above it, but not "blocked" below it: light can pass through a dip narrower than the wedge. A test builds exactly that: a 300 m wall 5 km away with a 1° gap inside a 2° wedge. The wall is the wedge's highest terrain (3.3°), yet a line of sight at 1° through the gap is clear, and the interval does not call it blocked.

| Check | Result |
| --- | --- |
| Skyline at 1200 random single azimuths, measured independently by dense sampling along each azimuth (`lineofsight.azimuth_profile`), 25 cones, map error 0.5 m | All inside the interval; smallest margin 0.038° to the bottom, 0.030° to the top |
| The same on terrain moved within the error model four ways (random up/down per pixel, all up, all down, waves), 400 azimuths each | All inside the interval |
| **Spec cross-check:** 3480 points on 120 Sun discs placed within 0.6° of the skyline, each tested with a direct 3D line of sight through the terrain (`lineofsight.ray_blocked`) | All 1294 points classified lit are reached by their ray; all 1239 classified blocked are stopped; 947 uncertain |
| Smooth sphere, no map error | The exact horizon dip is inside the interval; error below ±0.0001° |
| Error grows with the map's height error (none, 0.25 m, 1 m) and with its horizontal error (0, 5 m) | Yes, in every wedge |

**The line-of-sight method.** A line of sight is followed out from the eye in steps of 1/8 of the finest pixel and compared with the terrain below or above each step. It shares no code with the skyline search, only the terrain surface. It is a sampling method, not a proof; that is why it is the referee and the skyline search is the product.

**Size of the error, 25 cones 1 to 6 km away, 2 m mast** (`skyline_err_deg`, degrees):

| Map height error sigma | Mean | Largest |
| --- | --- | --- |
| none | 0.026 | 0.08 |
| 0.5 m | 0.15 | 0.38 |
| 1 m | 0.39 | 1.0 |

Without map error, what is left is how much the skyline genuinely varies inside one 0.1° wedge (the record has one value per wedge), plus the numerical error. With map error, the largest values come from ground a few hundred metres from the eye, which the model allows to be up to 3 sigma higher than the eye's own ground. These figures depend directly on the error model's three proposed values: 3 sigma, 6° of slope error, and no error relative to the eye within one pixel diagonal.

**Not included in this bound:** the Sun and Earth positions themselves (up to 0.000027°, `docs/ACCURACY.md` above) and the flattening of the Earth's disc (up to 0.0012°), which belong to the browser's calculation, not to the terrain.

## Not yet verified

- Elevation reading: the projection is verified (the engine's formulas agree with the projection declared inside the four coarse map files to better than a micrometre, `test_projection_is_the_one_the_map_files_declare`). Pixel registration against known features and published heights: with the LOLA reader.
- The error bound on the real maps, with their published per-pixel errors and horizontal accuracy (the horizontal accuracy of the LOLA product is still to be taken from its paper).
- Skyline speed and interval width on the real maps.
- Illumination against published south polar studies: with the real products.
