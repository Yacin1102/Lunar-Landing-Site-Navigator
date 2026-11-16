# Web interface

What the browser app shows, as built. The plan it was built from is `docs/UI_PLAN.md`.

## Layout

A top bar (name, Globe / Map toggle, About), the stage with the scene and the time controls under it, and one side panel. On a phone the panel sits under the stage.

## Scenes

| Scene | Address | What it shows |
| --- | --- | --- |
| Globe | `#/globe` | The Moon in 3D, opening on the south pole. Colour from LROC, relief from LOLA at true scale. Lit from the Sun's true direction at the selected time, plus a fill light (stated on screen). Site markers; point at one for its name, click to open it. |
| Polar map | `#/map` | The LOLA shaded relief to 80 S in polar stereographic projection, longitude 0 up. Markers, scale bar (exact at the pole), position under the cursor, zoom and pan. |
| Site: terrain | `#/site/{id}` | The site's 4.8 km elevation patch in 3D with no vertical exaggeration. Slopes are shaded by the Sun's direction; shadows come from the shade grid; the scene is dimmed by the share of the Sun visible from the site. A post marks the site and an arrow points north. |
| Site: sky | same, Sky tab | The sky from the eye: azimuth across, elevation up, same scale both ways. The Sun and the Earth are drawn first and the terrain in front, so a half-set Sun shows half a disc. Dashed gold lines show the skyline's uncertainty. Buttons: Whole sky, Find Sun, Find Earth, Magnify x10. |
| Geometry | same, Geometry tab | Moon, Earth and Sun at the true angle between them, distances on a logarithmic scale with labelled rings. |
| Custom point | `#/point/{lat},{lon}` | Sky and geometry only. No terrain is drawn; a dashed line marks the smooth-sphere horizon. |

`?t={ms}` after any address is the selected time, UTC milliseconds since 1970.

## What is to scale and what is not

- Sun and Earth positions and disc sizes are true. With Magnify on, discs are drawn 10 times larger and a line on screen says so; positions do not change.
- Terrain and globe relief have no vertical exaggeration.
- The terrain picture's brightness is exposed to its brightest ground, because the polar Sun is always low. The note on screen says so.
- Geometry distances are logarithmic and the icons are not to scale; the picture says both.
- The Earth's phase is exact. Its rotation is not known to the app, so one side always faces the viewer; a note says "rotation approximate".

## Time

All times are UTC. The date field sets the start of a 30-day window; the slider moves inside it; Play advances by 1, 6, 24 or 96 hours of Moon time per second and stops at the window's end. The date field cannot leave the timetable (16 Nov 2026 to 1 Jan 2040).

## Readouts (side panel, curated site)

Sun: whether sunlight reaches the site (Yes / No / Uncertain), the visible share of the disc as a range, sunlight in W/m2 as a range, time to sunset, elevation, azimuth, disc size. Earth: the same, plus its sunlit share. Battery: charge at the selected time, starting full at the window's start, for the panel area, efficiency, capacity and load typed in the fields below it; those four are the user's assumptions. Below: the site's record and the data behind its answers.

A custom point shows directions, disc sizes and distances only, from height 0 m.

## Look

True black background, one accent (pale gold), one typeface (IBM Plex Sans, bundled). Tokens in `web/src/styles/tokens.css`.

## Screenshots

`docs/screenshots/`, written by `npm run e2e` at 1440x900 (`-desktop`) and 390x844 (`-phone`): `globe`, `map`, `point-sky`, `site-terrain`, `site-sky`, `site-sky-whole-magnified`, `site-geometry`, `about`, and the two measuring views `probe-sun-half-set` and `probe-earth-phase` (desktop only).
