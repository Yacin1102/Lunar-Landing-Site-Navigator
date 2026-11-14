# Python engine

Reads NASA data once and writes the prepared files the web app uses, and serves live skylines for custom points. **Scope: the Moon's south polar region only.** Goal, split and contracts: `spec/ENGINE_GUIDE.md`.

- Inputs (you choose and download them; not committed): `kernels/` (SPICE) and `dem/` (LOLA south polar elevation maps). Record what was downloaded and why.
- Outputs: `../web/public/data/`. Fixtures: `../web/engine/tests/fixtures/`.

## Priorities

Plan the module layout and the pull requests yourself and record the plan in `docs/PROGRESS.md`. Deliver value in roughly this order, so the web side is unblocked early:

1. Choose and download the data; Sun/Earth timetable.
2. Researched, sourced list of 10 south polar sites.
3. Correct elevation reading and high-precision skylines with error bounds for all curated sites, cross-checked by an independent method; plus the event fixtures.
4. Live skyline API.
5. Terrain patches and shade grids for curated sites; manifest.
