# Lunar Landing Site Evaluator

NASA Space Apps Challenge entry. A web app that tells mission planners, for any site and time **in the Moon's south polar region**, whether sunlight reaches the site and whether the Earth is visible, how much of the Sun's disc clears the terrain, how long until sunset or Earthset, and what that means for power and communications.

**Scope: south pole only.** Nothing is built for the rest of the Moon. **Precision comes first.** The lit / not-lit answer must be provable, with an uncertainty bound, and never a guess (spec section 7).

`spec/ENGINE_GUIDE.md` holds the goal, the Python/TypeScript split and the data contracts. The contracts (file names, fields, units, order) and the shared rules are binding. Everything else is yours to design: algorithms, module layout, libraries, build order and tests. `spec/` is input. `docs/` is output: documentation you write from the actual code.

## The one rule

If something depends on the time or settings the user chooses, the **TypeScript app** (`web/`) does it in the browser. If it depends only on NASA data, the **Python engine** (`python/`) does it once, ahead of time. The two meet only through `web/public/data/` and the live API.

## Data

Choose and download the SPICE kernels (`python/kernels/`) and LOLA south polar elevation maps (`python/dem/`) you need, picking the products that give maximum precision. Record every file (URL, version, checksum, why it was chosen) so the download can be repeated. Never commit the data. Read each label before using a file (spec section 3).

Site coordinates are not provided. Research 10 south polar sites from authoritative sources and record each source (spec section 6).

## Shared rules (every file and API response)

Latitude -90 to 90; longitude east-positive -180 to 180; azimuth from north, clockwise; angles in degrees; heights and distances in metres; Sun/Earth positions in km; times in UTC milliseconds since 1970; height reference sphere R = 1737.4 km; frame `MOON_ME`; grids rows north to south and columns west to east; binary Float32 little-endian with a JSON label carrying `version`. Convert raw inputs (LOLA 0 to 360 longitudes, SPICE radians and TDB) at the edges. When code touches these, say in the PR which rules you applied.

## Working agreement

The person running Claude reviews every change but does not write code. So:

- Prove every part with pytest tests and show the real output. Never claim success without it.
- Write clear docstrings (role, how it works in plain words, units) and keep `docs/ARCHITECTURE.md` (with Mermaid diagrams) in step with the code as built.
- Keep `docs/PROGRESS.md` current: what is done, decisions taken, proposed spec changes, open questions. Read it at the start of every session.
- Work on a branch, commit, and open a pull request with `gh pr create`. Never push to `main`. Split the work into reviewable pull requests however makes sense.
- Never change a contract silently. If one seems wrong, explain why and propose the change.

## When compacting

Always preserve: what `docs/PROGRESS.md` says is next, the files changed, the test command and its last result, and any open contract question.
