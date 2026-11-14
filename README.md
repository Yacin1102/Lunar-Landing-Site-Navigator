# Lunar Landing Site Navigator

A web app that shows, for any site and date in the Moon's south polar region, whether sunlight reaches the site and the Earth is visible, for how long, and what that means for power and communications.

## The hackathon

This project is our team's entry for the NASA Space Apps Challenge 2026, challenge "Lunar Landing Site Navigator".
The challenge asks teams to build a tool for rapid lunar landing site evaluation by combining site choice, time selection, horizon-aware Sun and Earth visibility, and mission-relevant power and communication metrics.

## Our mission

Lighting and Earth visibility decide whether a landing is feasible.
If the Sun is low or gone, solar power drops and systems must survive the two-week lunar night.
If Earth is hidden, direct radio contact is lost.

The Moon's south pole is especially demanding.
The Sun skims the horizon there, shadows stretch for kilometres, and small changes in location or date can change conditions completely.

## Planned features

- 10 curated south polar landing sites and custom south polar coordinates
- Date and time selection with a timeline and animation
- Sun and Earth position in the site's sky, accounting for surrounding terrain
- Countdowns to sunset and Earthset
- Solar elevation, partial visibility of the Sun's disc, solar power and battery estimates
- Side-by-side comparison of site and date scenarios
- 3D view with shading for curated sites
- Explanations for non-experts about why the Moon is so different from Earth

## How it works (planned)

A Python engine prepares data once from NASA's SPICE kernels (positions of the Sun, Earth and Moon) and LOLA elevation maps (lunar terrain).
A TypeScript web app computes everything that depends on the chosen time directly in the browser, so the interface responds instantly.

## NASA data and tools

- [NAIF SPICE generic kernels](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/)
- [LOLA gridded elevation data (PDS)](https://imbrium.mit.edu/)
- [LOLA south polar elevation models (NASA GSFC)](https://pgda.gsfc.nasa.gov/products/90)
- [JPL Horizons, used for validation](https://ssd-api.jpl.nasa.gov/doc/horizons.html)
- [Moon Trek map tiles](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=moon)

## Accuracy

Sun and Earth positions will be checked against JPL Horizons.
Terrain detail is limited by the resolution of the elevation maps, and the app will show that limit with every result.

## Team

- Yassine Saad
- Yassine Bezzaouia
- Yassine Shili
- Mohamed Achref Elloumi
- Mohamed Aziz Bezzaouia

## Status

In development.
