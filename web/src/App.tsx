import { useEffect, useRef, useState } from "react";
import { timetableSpan } from "../engine/astro";
import type { DataBundle } from "../engine/runtime-types";
import { useData } from "./state/useData";
import { useRoute } from "./state/useRoute";
import { formatRoute, type Route } from "./state/route";
import { TopBar } from "./ui/TopBar";
import { SiteList } from "./ui/SiteList";
import { SiteSummary } from "./ui/SiteSummary";
import { PointSummary } from "./ui/PointSummary";
import { About } from "./ui/About";
import { CoordinateInput } from "./ui/CoordinateInput";
import { Stage, type SiteTab } from "./ui/Stage";
import { TimeBar, SPEEDS, WINDOW_DAYS } from "./ui/TimeBar";
import { STARTING_POWER, type PowerSettings } from "./ui/Readouts";

const DAY_MS = 86_400_000;

/**
 * The application shell.
 *
 * Role: load the engine's prepared data once, read the route from the URL, and lay out the three
 * fixed regions: a quiet top bar, the stage (the scene and the time controls) and one side panel.
 *
 * How it works: `useData` reports loading, error or ready. Until the data is ready nothing but a
 * status line is shown, so no number can appear that did not come from a checked file. When the
 * manifest says the folder holds mock data, a banner says so on every screen (handoff rule 3).
 */
export default function App() {
  const data = useData();
  const [route, navigate] = useRoute();
  const [about, setAbout] = useState(false);

  if (data.status !== "ready") {
    return (
      <div className="app">
        <TopBar route={route} onNavigate={navigate} about={about} onAbout={() => setAbout(!about)} />
        {data.status === "loading" ? (
          <p className="status" role="status">Loading the prepared lunar data…</p>
        ) : (
          <div className="status" role="alert">
            <h1>The prepared data could not be loaded</h1>
            <p>{data.message}</p>
            <p>Nothing is shown, because every number in this app must come from a checked file. Reload the page to try again.</p>
          </div>
        )}
      </div>
    );
  }
  return <Workspace bundle={data.bundle} route={route} navigate={navigate} about={about} setAbout={setAbout} />;
}

/**
 * Everything that needs the data: the selected time, playback, and the scene and panel for the
 * current route.
 *
 * Time: one UTC instant, kept inside the timetable's span. It starts at the route's `t`, or at
 * the present moment, or at the timetable's first instant if the present is outside the span.
 * The slider covers 30 days from `windowStartMs`. While playing, the time advances by
 * `speed` hours of Moon time per second and stops at the end of the window. When playback is
 * paused the time is written back into the address, so the view can be shared.
 */
function Workspace({ bundle, route, navigate, about, setAbout }: { bundle: DataBundle; route: Route; navigate: (route: Route) => void; about: boolean; setAbout: (open: boolean) => void }) {
  const span = timetableSpan(bundle.ephemeris.label);
  const clamp = (timeMs: number) => Math.min(Math.max(timeMs, span.startMs), span.endMs);
  const [windowStartMs, setWindowStartMs] = useState(() => clamp(route.timeMs ?? Date.now()));
  const [timeMs, setTimeMs] = useState(windowStartMs);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(SPEEDS[1]);
  const [tab, setTab] = useState<SiteTab>("terrain");
  const [power, setPower] = useState<PowerSettings>(STARTING_POWER);
  const windowEndMs = Math.min(windowStartMs + WINDOW_DAYS * DAY_MS, span.endMs);

  // Playback: advance by real elapsed time, so the speed is the same at any frame rate.
  const speedRef = useRef(speed);
  speedRef.current = speed;
  useEffect(() => {
    if (!playing) return undefined;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const elapsed = now - last;
      last = now;
      setTimeMs((current) => {
        const next = current + elapsed * speedRef.current * 3600;
        if (next >= windowEndMs) {
          setPlaying(false);
          return windowEndMs;
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, windowEndMs]);

  // A time that arrives with a new address (a pasted link, the back button) becomes the selected time.
  const routeTime = route.timeMs;
  useEffect(() => {
    if (routeTime === undefined) return;
    const next = Math.min(Math.max(routeTime, span.startMs), span.endMs);
    setTimeMs((current) => {
      if (Math.round(current) === Math.round(next)) return current;
      setWindowStartMs(next);
      setPlaying(false);
      return next;
    });
  }, [routeTime, span.startMs, span.endMs]);

  // Keep the address in step with the time once it stops changing.
  useEffect(() => {
    if (playing) return;
    window.history.replaceState(null, "", formatRoute({ ...route, timeMs }));
  }, [route, timeMs, playing]);

  const go = (next: Route) => navigate({ ...next, timeMs, probe: undefined });
  const openSite = (siteId: string) => go({ view: "site", siteId });
  const label = about ? "About" : route.view === "site" ? "Site" : route.view === "point" ? "Custom point" : "Sites";

  return (
    <div className="app">
      <TopBar route={route} onNavigate={(next) => { setAbout(false); go(next); }} about={about} onAbout={() => setAbout(!about)} />
      {bundle.manifest.data_kind === "mock" && (
        <p className="mock-banner" role="alert">Mock data: invented terrain. Nothing on this screen is a real verdict.</p>
      )}
      <div className="workspace">
        <main className="stage" data-scene={route.view}>
          <Stage route={route} bundle={bundle} timeMs={timeMs} tab={tab} onTab={setTab} onOpenSite={openSite} />
          <TimeBar
            timeMs={timeMs}
            windowStartMs={windowStartMs}
            windowEndMs={windowEndMs}
            spanStartMs={span.startMs}
            spanEndMs={span.endMs}
            playing={playing}
            speed={speed}
            onTime={setTimeMs}
            onWindowStart={(start) => { setWindowStartMs(start); setTimeMs(start); setPlaying(false); }}
            onPlaying={(next) => { if (next && timeMs >= windowEndMs) setTimeMs(windowStartMs); setPlaying(next); }}
            onSpeed={setSpeed}
          />
        </main>
        <aside className="panel" aria-label={label}>
          {about ? (
            <About bundle={bundle} onClose={() => setAbout(false)} />
          ) : route.view === "site" ? (
            <SiteSummary siteId={route.siteId} bundle={bundle} timeMs={timeMs} windowStartMs={windowStartMs} windowEndMs={windowEndMs} power={power} onPower={setPower} />
          ) : route.view === "point" ? (
            <PointSummary lat={route.lat} lon={route.lon} bundle={bundle} timeMs={timeMs} />
          ) : (
            <SiteList sites={bundle.sites} onOpen={openSite}>
              <CoordinateInput region={bundle.manifest.service_region} onOpen={(lat, lon) => go({ view: "point", lat, lon })} />
            </SiteList>
          )}
        </aside>
      </div>
    </div>
  );
}
