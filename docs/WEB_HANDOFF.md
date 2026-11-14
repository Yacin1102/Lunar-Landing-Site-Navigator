# Web handoff

The browser consumes only prepared files under one configurable folder (`/data-mock` by default, or `/data` in a real deployment). The current checkout did not contain the upstream handoff package, so this document records the provisional web-side contract used to keep the app testable.

All JSON uses version `1`, angles are degrees, heights and distances are metres, body vectors are kilometres in `MOON_ME`, and times are UTC milliseconds. Binary arrays are little-endian typed arrays whose sizes are read from their adjacent JSON labels.

The loader supports `manifest.json`, `sites.json`, `ephem.json`/`ephem.bin`, `skylines/{id}.json`, optional `terrain/{id}.json`/`.bin`, and optional shade labels plus skyline/normal binaries. A manifest with `data_kind: "mock"` always produces a visible warning; missing live API data is an unavailable verdict rather than a smooth-Moon guess.
