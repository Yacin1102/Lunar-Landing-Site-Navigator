// Audit: sunrise, sunset, Earthrise and Earthset. Expected values come from SPICE
// (events.json, made by python/scripts/build_fixtures.py) and from curves solved by hand.
import { describe, expect, it } from "vitest";
import { findCrossings, findEvents } from "../../events";
import { calculateMetrics, intervalsFromCrossings } from "../../metrics";
import type { EventsFixture } from "../../types";
import { flatSkyline, loadTimetable, readJson } from "./helpers";

const MINUTE = 60_000;

describe("events against SPICE (events.json)", () => {
  it("finds every event of the 8 windows within 60 seconds, with the right counts", () => {
    const { label, values } = loadTimetable();
    const fixture = readJson<EventsFixture>("web/engine/tests/fixtures/events.json");
    const ground = flatSkyline(0, 0, 0.1, 0, 0); // smooth Moon, eye on the ground
    let worst = 0;
    for (const c of fixture.cases) {
      const ev = findEvents(values, label, ground, { lat: c.lat, lon: c.lon }, c.start_ms, c.end_ms);
      for (const [mine, theirs] of [[ev.sunrise, c.sunrise_ms], [ev.sunset, c.sunset_ms], [ev.earthrise, c.earthrise_ms], [ev.earthset, c.earthset_ms]]) {
        expect(mine.length, c.name).toBe(theirs.length);
        mine.forEach((t, i) => {
          worst = Math.max(worst, Math.abs(t - theirs[i]));
          expect(Math.abs(t - theirs[i]), `${c.name}, event ${i}`).toBeLessThan(60_000);
        });
      }
    }
    console.log(`events.json (${fixture.cases.length} windows): worst timing error ${(worst / 1000).toFixed(1)} s (pass mark 60 s)`);
  }, 120_000);
});

describe("short grazes between scan samples", () => {
  // A curve that pokes above the horizon by 0.001 degrees for exactly 6 minutes, centred between
  // two 10-minute samples: f(t) = 0.001 - k (t - peak)^2 with roots at peak +- 3 min.
  const peak = 25 * MINUTE;
  const k = 0.001 / (3 * MINUTE) ** 2;
  const graze = (t: number) => 0.001 - k * (t - peak) ** 2;

  it("is invisible to the 10-minute samples themselves", () => {
    for (let t = 0; t <= 60 * MINUTE; t += 10 * MINUTE) expect(graze(t)).toBeLessThan(0);
  });

  it("is found by the search, rise and set to the second", () => {
    const c = findCrossings(graze, 0, 60 * MINUTE, 0.01 / MINUTE);
    expect(c.rise_ms).toHaveLength(1);
    expect(c.set_ms).toHaveLength(1);
    expect(Math.abs(c.rise_ms[0] - (peak - 3 * MINUTE))).toBeLessThan(1000);
    expect(Math.abs(c.set_ms[0] - (peak + 3 * MINUTE))).toBeLessThan(1000);
  });

  it("is found in the first and the last scan interval too", () => {
    const early = (t: number) => 0.001 - k * (t - 4 * MINUTE) ** 2;
    const c1 = findCrossings(early, 0, 60 * MINUTE, 0.02 / MINUTE);
    expect([c1.rise_ms.length, c1.set_ms.length]).toEqual([1, 1]);
    const late = (t: number) => 0.001 - k * (t - 56 * MINUTE) ** 2;
    const c2 = findCrossings(late, 0, 60 * MINUTE, 0.02 / MINUTE);
    expect([c2.rise_ms.length, c2.set_ms.length]).toEqual([1, 1]);
  });

  it("handles several crossings and a window with one more rise than set", () => {
    // sin wave: positive from 0 to 30 min, negative to 60, ... starting just below zero.
    const wave = (t: number) => Math.sin(2 * Math.PI * (t - 1 * MINUTE) / (60 * MINUTE));
    const c = findCrossings(wave, 0, 100 * MINUTE, 0.11 / MINUTE);
    expect(c.rise_ms.map((t) => Math.round(t / MINUTE))).toEqual([1, 61]);
    expect(c.set_ms.map((t) => Math.round(t / MINUTE))).toEqual([31, 91]);
    const c2 = findCrossings(wave, 0, 80 * MINUTE, 0.11 / MINUTE);
    expect([c2.rise_ms.length, c2.set_ms.length]).toEqual([2, 1]);
  });
});

describe("metrics from the crossings", () => {
  const day = 86_400_000;
  const none = { rise_ms: [], set_ms: [] };
  const noEvents = { sunrise: [], sunset: [], earthrise: [], earthset: [] };

  it("counts a window that is dark all the way as one night of the window's length", () => {
    const lit = intervalsFromCrossings(false, none, 0, day);
    const m = calculateMetrics(noEvents, 0, 0, day, lit, lit, []);
    expect(m.longest_night_ms).toBe(day);
    expect(m.sunlight_hours).toBe(0);
  });

  it("counts a window that starts lit, and one that starts dark", () => {
    const startsLit = intervalsFromCrossings(true, { rise_ms: [], set_ms: [6 * 3600000] }, 0, day);
    expect(startsLit).toEqual([{ start_ms: 0, end_ms: 6 * 3600000 }]);
    const startsDark = intervalsFromCrossings(false, { rise_ms: [6 * 3600000], set_ms: [] }, 0, day);
    expect(startsDark).toEqual([{ start_ms: 6 * 3600000, end_ms: day }]);
    const m = calculateMetrics(noEvents, 0, 0, day, startsDark, startsDark, startsLit);
    expect(m.sunlight_hours).toBe(18);
    expect(m.longest_night_ms).toBe(6 * 3600000);
    expect(m.both_visible_windows).toEqual([]);
  });

  it("counts the countdown from the chosen time, never to a sunset already past", () => {
    const events = { sunrise: [], sunset: [2 * 3600000, 20 * 3600000], earthrise: [], earthset: [] };
    const m = calculateMetrics(events, 10 * 3600000, 0, day, [], [], []);
    expect(m.time_to_next_sunset_ms).toBe(10 * 3600000);
  });

  it("reports uncertain hours as the gap between possible and certain sunlight", () => {
    const certain = [{ start_ms: 0, end_ms: 4 * 3600000 }];
    const possible = [{ start_ms: 0, end_ms: 5 * 3600000 }];
    const m = calculateMetrics(noEvents, 0, 0, day, certain, possible, certain);
    expect(m.uncertain_sun_hours).toBe(1);
    expect(m.both_visible_windows).toEqual(certain);
  });
});
