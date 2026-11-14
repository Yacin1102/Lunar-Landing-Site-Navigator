# Instructions for the TypeScript web app

You build the browser side (web/) of a lunar south pole landing-site evaluator for the NASA Space Apps Challenge.

Read first, every time:
- docs/WEB_HANDOFF.md: what the Python engine provides, formulas, open decisions
- web/engine/types.ts and docs/schemas/: data shapes. Never change them; if one seems wrong, say so in the pull request.
- spec/ENGINE_GUIDE.md sections 1, 4 to 11 and 14: the design and the contracts

Rules:
- Python prepares data; TypeScript computes everything that depends on the user's chosen time or settings, and draws everything. Never open NASA files.
- Scope: lunar south pole only.
- Units: degrees (never radians in data), metres, km for Sun/Earth vectors, UTC milliseconds, longitude -180 to 180, azimuth from north clockwise.
- Read sizes, steps and counts from each file's JSON label or manifest.json. Never hard-code them: the real data will differ from the mock data.
- Never hard-code site names or coordinates. Everything about sites comes from sites.json and manifest.json; the current sites are placeholders.
- Load data from one configurable folder: web/public/data-mock/ for now, web/public/data/ when real data arrives.
- While manifest.json says data_kind is "mock", show a clear "mock terrain data" banner.
- The live API (/api/skyline) does not exist yet. Build the client against the final types, and handle "server unreachable" with a clear message.
- The lit / blocked / uncertain definition is provisional (docs/PROGRESS.md item 11). Keep it in ONE module so it is easy to change.
- Every calculation module has unit tests (Vitest). The astro core must pass web/engine/tests/fixtures/altaz.json (within 0.01 degrees) and events.json (within 60 seconds).
- Every function has a comment explaining its role and, in plain words, how it works. The reviewer has no astronomy background.

Boundaries:
- Only change files in web/ (and docs/ pages about the web app).
- Never modify python/, spec/, CLAUDE.md or .claude/. Those belong to the Python engine, built by another agent.

Working method:
- Work through tasks in order. After each task, run all tests; never continue with failing tests. Commit after each task.
- If you get stuck on the same problem twice, stop and explain instead of working around it.
- Finish by opening ONE pull request against main, listing each task, its test results, and anything to check by hand.
