import { useEffect, useMemo, useState } from "react";
import { directionsAt, interpolateBody, sitePosition } from "../../engine/astro";
import { evaluateInWorker } from "../../engine/client";
import { simulateBattery, solarIrradianceWm2, type PowerSample } from "../../engine/power";
import type { DataBundle, Direction, EventSet, Visibility } from "../../engine/runtime-types";
import type { Site, Skyline } from "../../engine/types";
import { classifyVisibility, visibleDiscFraction } from "../../engine/visibility";
import { angularDiameterDeg, earthPhaseAngleDeg, litFraction } from "../lib/geometry";
import { Facts, type Fact } from "./Facts";

/** The user's own assumptions for the power readout. They are inputs, not facts about a mission. */
export interface PowerSettings {
  area_m2: number;
  efficiency: number;
  capacity_Wh: number;
  load_W: number;
}

/** Starting values of the assumption fields. Shown on screen and editable. */
export const STARTING_POWER: PowerSettings = { area_m2: 2, efficiency: 0.25, capacity_Wh: 2000, load_W: 100 };

/** How far past the window's start sunsets and Earthsets are searched, days. */
const SEARCH_DAYS = 60;
/** Spacing of the battery simulation's samples, minutes. */
const BATTERY_STEP_MIN = 30;
const DAY_MS = 86_400_000;

/** Write a duration as hours and minutes: "125 h 04 min". */
export function formatHoursMinutes(durationMs: number): string {
  const minutes = Math.round(durationMs / 60_000);
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

const VERDICT: Record<Visibility["status"], string> = { visible: "Yes", blocked: "No", uncertain: "Uncertain" };

/** Write a visible fraction as its proven range: "42–58 %", or one number when both ends agree. */
function fractionRange(v: Visibility): string {
  const low = Math.round(v.fraction_low * 100);
  const high = Math.round(v.fraction_high * 100);
  return low === high ? `${low} %` : `${low}–${high} %`;
}

function directionFacts(name: string, d: Direction, body: "sun" | "earth"): Fact[] {
  return [
    { label: `${name} elevation`, value: `${d.el_deg.toFixed(2)}°` },
    { label: `${name} azimuth`, value: `${d.az_deg.toFixed(2)}° from north` },
    { label: `${name} disc`, value: `${angularDiameterDeg(body, d.distance_km).toFixed(3)}° across` },
    { label: `${name} distance`, value: `${Math.round(d.distance_km).toLocaleString("en-GB")} km` },
  ];
}

/** Sunlit fraction of the Earth's disc as seen from an eye position, 0 to 1. */
function earthLit(bundle: DataBundle, timeMs: number, lat: number, lon: number, heightM: number): number {
  const { label, values } = bundle.ephemeris;
  return litFraction(earthPhaseAngleDeg(interpolateBody(values, label, timeMs, 0), interpolateBody(values, label, timeMs, 3), sitePosition(lat, lon, heightM)));
}

/**
 * Readouts for a curated site at the selected time.
 *
 * How it works: directions and the lit / blocked / uncertain verdicts are computed here on
 * every time step with the engine's own functions against the site's full skyline (they are
 * cheap). The sunsets and Earthsets of the coming 60 days are found once per window by the
 * engine's event search in its Web Worker. The battery is the engine's `simulateBattery`, run
 * from the start of the time window with a full battery and the assumptions typed below; the
 * readout is its charge at the selected time.
 *
 * Every value carries its unit. The visible fraction is shown as the proven range against
 * skyline + error and skyline - error, and an uncertain case is called uncertain.
 */
export function SiteReadouts({
  bundle, site, skyline, timeMs, windowStartMs, windowEndMs, power, onPower,
}: {
  bundle: DataBundle; site: Site; skyline: Skyline; timeMs: number; windowStartMs: number; windowEndMs: number; power: PowerSettings; onPower: (next: PowerSettings) => void;
}) {
  const { label, values } = bundle.ephemeris;
  const directions = directionsAt(values, label, timeMs, site.lat, site.lon, skyline.elev_m, skyline.mast_m);
  const sun = classifyVisibility(directions.sun, "sun", skyline);
  const earth = classifyVisibility(directions.earth, "earth", skyline);

  const [events, setEvents] = useState<{ key: string; events: EventSet }>();
  const key = `${site.id}:${windowStartMs}`;
  useEffect(() => {
    let cancelled = false;
    evaluateInWorker(bundle, site.id, windowStartMs, windowStartMs, windowStartMs + SEARCH_DAYS * DAY_MS).then(
      (evaluation) => {
        if (!cancelled) setEvents({ key, events: evaluation.events });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [bundle, site.id, windowStartMs, key]);

  const charge = useMemo(() => {
    const samples: PowerSample[] = [];
    for (let t = windowStartMs; t <= windowEndMs; t += BATTERY_STEP_MIN * 60_000) {
      const d = directionsAt(values, label, t, site.lat, site.lon, skyline.elev_m, skyline.mast_m).sun;
      samples.push({ time_ms: t, sun: d, visible_fraction: visibleDiscFraction(d, "sun", skyline, 0) });
    }
    try {
      return simulateBattery(samples, { type: "tracking", area_m2: power.area_m2, efficiency: power.efficiency }, { capacity_Wh: power.capacity_Wh, initial_Wh: power.capacity_Wh, load_W: power.load_W }).charge_Wh;
    } catch {
      return undefined;
    }
  }, [values, label, site, skyline, windowStartMs, windowEndMs, power]);

  const countdown = (times: number[] | undefined, up: boolean, body: string): string => {
    if (!up) return `${body} is not in view`;
    if (!times) return "Searching…";
    const next = times.find((time) => time >= timeMs);
    return next === undefined ? `None in the ${SEARCH_DAYS} days searched` : formatHoursMinutes(next - timeMs);
  };
  const known = events?.key === key ? events.events : undefined;

  let battery = "Check the assumptions below";
  if (charge && charge.length > 0) {
    const after = charge.findIndex((sample) => sample.time_ms >= timeMs);
    const b = charge[after < 0 ? charge.length - 1 : after];
    const a = charge[Math.max(0, (after < 0 ? charge.length : after) - 1)];
    const wh = b.time_ms === a.time_ms ? b.charge_Wh : a.charge_Wh + ((b.charge_Wh - a.charge_Wh) * (timeMs - a.time_ms)) / (b.time_ms - a.time_ms);
    battery = `${Math.round(wh)} Wh of ${power.capacity_Wh} Wh (${Math.round((wh / power.capacity_Wh) * 100)} %)`;
  }

  const sunFacts: Fact[] = [
    { label: "Sunlight reaches the site", value: <strong data-testid="sun-verdict">{VERDICT[sun.status]}</strong> },
    { label: "Sun’s disc visible", value: <span data-testid="sun-fraction">{fractionRange(sun)}</span> },
    { label: "Sunlight", value: `${Math.round(solarIrradianceWm2(directions.sun.distance_km, sun.fraction_low))}–${Math.round(solarIrradianceWm2(directions.sun.distance_km, sun.fraction_high))} W/m²` },
    { label: "Time to sunset", value: <span data-testid="sunset">{countdown(known?.sunset, sun.fraction > 0, "The Sun")}</span> },
    ...directionFacts("Sun", directions.sun, "sun").slice(0, 3),
  ];
  const earthFacts: Fact[] = [
    { label: "Earth in view", value: <strong>{VERDICT[earth.status]}</strong> },
    { label: "Earth’s disc visible", value: fractionRange(earth) },
    { label: "Time to Earthset", value: countdown(known?.earthset, earth.fraction > 0, "The Earth") },
    ...directionFacts("Earth", directions.earth, "earth").slice(0, 3),
    { label: "Earth sunlit", value: `${(earthLit(bundle, timeMs, site.lat, site.lon, skyline.elev_m + skyline.mast_m) * 100).toFixed(1)} % of its disc` },
  ];
  const field = (name: keyof PowerSettings, text: string, unit: string, step: number) => (
    <label className="field">
      <span>{text}</span>
      <input
        type="number"
        min="0"
        step={step}
        value={power[name]}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (Number.isFinite(value) && value >= 0) onPower({ ...power, [name]: value });
        }}
      />
      <span>{unit}</span>
    </label>
  );

  return (
    <>
      <h2 className="group-title">Sun</h2>
      <Facts facts={sunFacts} />
      <h2 className="group-title">Earth</h2>
      <Facts facts={earthFacts} />
      <h2 className="group-title">Battery</h2>
      <Facts facts={[{ label: "Charge now", value: <span data-testid="battery">{battery}</span> }]} />
      <p className="panel-lead">
        Full at the start of the time window, then charged by a Sun-tracking panel and drained by a constant load. These are your assumptions:
      </p>
      <div className="fields">
        {field("area_m2", "Panel area", "m²", 0.5)}
        {field("efficiency", "Panel efficiency", "0–1", 0.01)}
        {field("capacity_Wh", "Battery capacity", "Wh", 100)}
        {field("load_W", "Load", "W", 10)}
      </div>
    </>
  );
}

/**
 * Readouts for a custom point: where the Sun and the Earth are, and nothing more. No skyline
 * exists for the point, so there is no verdict, no visible fraction and no countdown. The eye is
 * taken at height 0 m on the reference sphere, and the panel says so.
 */
export function PointReadouts({ bundle, lat, lon, timeMs }: { bundle: DataBundle; lat: number; lon: number; timeMs: number }) {
  const { label, values } = bundle.ephemeris;
  const directions = directionsAt(values, label, timeMs, lat, lon, 0, 0);
  return (
    <>
      <h2 className="group-title">Sun</h2>
      <Facts facts={directionFacts("Sun", directions.sun, "sun")} />
      <h2 className="group-title">Earth</h2>
      <Facts facts={[...directionFacts("Earth", directions.earth, "earth"), { label: "Earth sunlit", value: `${(earthLit(bundle, timeMs, lat, lon, 0) * 100).toFixed(1)} % of its disc` }]} />
      <p className="panel-lead">Elevations are measured from the level plane of a point at height 0 m on the 1737.4 km sphere. Real terrain can hide either body.</p>
    </>
  );
}
