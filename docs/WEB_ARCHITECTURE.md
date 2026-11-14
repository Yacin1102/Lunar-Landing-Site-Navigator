# Web architecture

The browser reads prepared products from one folder and performs all user-time calculations locally.

```mermaid
flowchart LR
  Data[manifest/sites/ephemeris/skylines] --> Loader[Prepared-data loader]
  Loader --> UI[React site menu]
  Loader --> Worker[Astro Web Worker]
  Worker --> Verdict[Visibility and events]
  Verdict --> Power[Power and battery]
  Power --> UI
```

The web engine uses degrees at its public boundaries, UTC milliseconds for time, and kilometres for Sun/Earth vectors. The mock files are synthetic and are always labelled in the UI.
