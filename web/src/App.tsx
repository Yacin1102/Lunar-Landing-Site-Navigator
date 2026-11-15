import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import { evaluateInWorker } from "../engine/client";
import { loadDataBundle } from "../engine/data";
import { panelPowerW } from "../engine/power";
import type { DataBundle, Direction } from "../engine/runtime-types";
import type { Site, Skyline } from "../engine/types";
import { fetchCustomSkyline } from "./api";
import { formatDegrees, formatDuration, formatLocalTime, formatPercent, formatPower, fromDateTimeInputValue, toDateTimeInputValue } from "./formatting";
import {
  buildTimeline,
  elevationRange,
  skyBodySize,
  skyPoint,
  timelineBounds,
  type ScenarioSummary,
  type TimelinePoint,
} from "./visual-model";
import { readSavedScenarios, saveScenariosToUrl, type SavedScenario } from "./url-state";

type ViewMode = "sky" | "terrain" | "map";
type ExperienceMode = "beginner" | "expert";
type Page = "dashboard" | "compare";

interface WorkerEvents {
  sunrise: number[];
  sunset: number[];
  earthrise: number[];
  earthset: number[];
}

interface WorkerResult {
  events?: WorkerEvents;
}

interface ExtraSite {
  site: Site;
  skyline: Skyline;
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8000";
const PANEL = { type: "tracking" as const, area_m2: 4, efficiency: 0.25 };

/** Render the focused mission dashboard without changing the existing astronomy engine. */
export default function App() {
  const [bundle, setBundle] = useState<DataBundle>();
  const [loadError, setLoadError] = useState<string>();
  const [extraSites, setExtraSites] = useState<ExtraSite[]>([]);
  const [scenarios, setScenarios] = useState<SavedScenario[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [view, setView] = useState<ViewMode>("sky");
  const [mode, setMode] = useState<ExperienceMode>("beginner");
  const [page, setPage] = useState<Page>("dashboard");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [spanDays, setSpanDays] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [workerResult, setWorkerResult] = useState<WorkerResult>();
  const [customLat, setCustomLat] = useState("-89");
  const [customLon, setCustomLon] = useState("0");
  const [customMessage, setCustomMessage] = useState<string>();
  const [introOpen, setIntroOpen] = useState(() => typeof window !== "undefined" && window.localStorage.getItem("lunar-intro-dismissed") !== "1");

  useEffect(() => {
    loadDataBundle()
      .then((loaded) => {
        setBundle(loaded);
        const saved = readSavedScenarios().filter((scenario) => loaded.sites.some((site) => site.id === scenario.siteId));
        const initialDate = loaded.ephemeris.label.t0_ms + 12 * 3600000;
        setScenarios((saved.length ? saved : [{ siteId: loaded.sites[0]?.id ?? "", dateMs: initialDate }]).slice(0, 4));
      })
      .catch((reason: unknown) => setLoadError(reason instanceof Error ? reason.message : "Prepared data could not be loaded."));
  }, []);

  const allSites = useMemo(() => [...(bundle?.sites ?? []), ...extraSites.map((entry) => entry.site)], [bundle, extraSites]);
  const extraSkylineMap = useMemo(() => new Map(extraSites.map((entry) => [entry.site.id, entry.skyline])), [extraSites]);
  const activeScenario = scenarios[activeIndex] ?? scenarios[0];
  const activeSite = allSites.find((site) => site.id === activeScenario?.siteId);
  const activeSkyline = activeScenario
    ? extraSkylineMap.get(activeScenario.siteId) ?? bundle?.skylines.get(activeScenario.siteId)
    : undefined;
  const effectiveBundle = useMemo(() => {
    if (!bundle) return undefined;
    return { ...bundle, sites: allSites, skylines: new Map([...bundle.skylines, ...extraSkylineMap]) };
  }, [allSites, bundle, extraSkylineMap]);
  const activeSummary = useMemo(
    () => effectiveBundle && activeSite && activeScenario
      ? buildTimeline(effectiveBundle, activeSite, activeSkyline, activeScenario.dateMs, spanDays)
      : undefined,
    [activeScenario, activeSite, activeSkyline, effectiveBundle, spanDays],
  );
  const bounds = activeScenario ? timelineBounds(activeScenario.dateMs, spanDays) : undefined;
  const currentPoint = activeSummary ? nearestPoint(activeSummary.points, activeScenario?.dateMs ?? 0) : undefined;

  useEffect(() => {
    if (scenarios.length) saveScenariosToUrl(scenarios);
  }, [scenarios]);

  useEffect(() => {
    if (playing || !effectiveBundle || !activeScenario || !activeSkyline || !bounds) return;
    let cancelled = false;
    evaluateInWorker(effectiveBundle, activeScenario.siteId, activeScenario.dateMs, bounds.startMs, bounds.endMs)
      .then((result) => {
        if (!cancelled) setWorkerResult(result as WorkerResult);
      })
      .catch(() => {
        if (!cancelled) setWorkerResult(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [activeScenario, activeSkyline, bounds, effectiveBundle, playing]);

  useEffect(() => {
    if (!playing || !activeScenario || !bounds) return;
    const timer = window.setInterval(() => {
      setScenarios((current) => current.map((scenario, index) => index === activeIndex
        ? { ...scenario, dateMs: Math.min(bounds.endMs, scenario.dateMs + bounds.stepMs) }
        : scenario));
    }, 250);
    return () => window.clearInterval(timer);
  }, [activeIndex, activeScenario, bounds, playing]);

  useEffect(() => {
    if (mode === "expert") setDetailsOpen(true);
  }, [mode]);

  /** Select a site, reusing an existing scenario when it is already open. */
  function selectSite(siteId: string): void {
    const existingIndex = scenarios.findIndex((scenario) => scenario.siteId === siteId);
    if (existingIndex >= 0) {
      setActiveIndex(existingIndex);
      return;
    }
    if (!siteId) return;
    const dateMs = activeScenario?.dateMs ?? bundle?.ephemeris.label.t0_ms ?? Date.now();
    setScenarios((current) => [...current, { siteId, dateMs }].slice(-4));
    setActiveIndex(Math.min(scenarios.length, 3));
  }

  /** Change the selected UTC instant without changing the active site. */
  function updateActiveDate(dateMs: number): void {
    if (!activeScenario || !Number.isFinite(dateMs)) return;
    setScenarios((current) => current.map((scenario, index) => index === activeIndex ? { ...scenario, dateMs } : scenario));
  }

  /** Request a terrain skyline for a custom south-polar coordinate. */
  async function addCustomSite(): Promise<void> {
    const lat = Number(customLat);
    const lon = Number(customLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > -80 || lon < -180 || lon > 180) {
      setCustomMessage("Latitude must be -90° to -80° and longitude -180° to 180°.");
      return;
    }
    setCustomMessage("Requesting terrain…");
    const result = await fetchCustomSkyline(API_BASE, lat, lon);
    if (!result.ok) {
      setCustomMessage(result.message);
      return;
    }
    const id = `custom_${lat.toFixed(4)}_${lon.toFixed(4)}`.replaceAll("-", "m").replaceAll(".", "p");
    const site: Site = { id, name: `Custom ${lat.toFixed(3)}°, ${lon.toFixed(3)}°`, lat, lon, category: "custom", has_terrain: false, has_shade_grid: false };
    setExtraSites((current) => [...current.filter((entry) => entry.site.id !== id), { site, skyline: result.skyline }]);
    setScenarios((current) => [...current.filter((scenario) => scenario.siteId !== id), { siteId: id, dateMs: activeScenario?.dateMs ?? Date.now() }].slice(-4));
    setActiveIndex(Math.min(scenarios.length, 3));
    setCustomMessage("Terrain loaded.");
  }

  /** Remove a scenario from the comparison page's saved set. */
  function removeScenario(index: number): void {
    setScenarios((current) => current.filter((_, candidateIndex) => candidateIndex !== index));
    setActiveIndex((current) => Math.max(0, Math.min(current, scenarios.length - 2)));
  }

  /** Store the first-visit explanation dismissal so returning visitors see the focused dashboard. */
  function dismissIntro(): void {
    window.localStorage.setItem("lunar-intro-dismissed", "1");
    setIntroOpen(false);
  }

  /** Put a map-picked coordinate into the custom point controls and open Details. */
  function pickCustomCoordinate(lat: number, lon: number): void {
    setCustomLat(lat.toFixed(4));
    setCustomLon(lon.toFixed(4));
    setDetailsOpen(true);
  }

  if (loadError) return <main className="app-shell"><aside className="error-panel" role="alert">{loadError}</aside></main>;
  if (!bundle || !activeScenario || !activeSite || !activeSummary || !currentPoint) return <main className="app-shell"><p className="loading">Loading mission data…</p></main>;

  if (page === "compare") {
    return <ComparePage
      scenarios={scenarios}
      summaries={buildComparisonSummaries(effectiveBundle, scenarios, allSites, extraSkylineMap, spanDays)}
      activeIndex={activeIndex}
      onBack={() => setPage("dashboard")}
      onSelect={setActiveIndex}
    />;
  }

  const nextSunset = workerResult?.events?.sunset.find((time) => time >= activeScenario.dateMs)
    ?? (activeSummary.timeToSunsetMs === undefined ? undefined : activeScenario.dateMs + activeSummary.timeToSunsetMs);
  const nextSunrise = workerResult?.events?.sunrise.find((time) => time >= activeScenario.dateMs);
  const nextEarthset = workerResult?.events?.earthset.find((time) => time >= activeScenario.dateMs)
    ?? (activeSummary.timeToEarthsetMs === undefined ? undefined : activeScenario.dateMs + activeSummary.timeToEarthsetMs);
  const nextEarthrise = workerResult?.events?.earthrise.find((time) => time >= activeScenario.dateMs);

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => setPage("dashboard")}>Lunar Landing Site Navigator</button>
        <label className="top-control">Site
          <select value={activeSite.id} onChange={(event) => selectSite(event.target.value)} aria-label="Select site">
            {allSites.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}
          </select>
        </label>
        <label className="top-control">UTC
          <input type="datetime-local" value={toDateTimeInputValue(activeScenario.dateMs)} onChange={(event) => updateActiveDate(fromDateTimeInputValue(event.target.value))} aria-label="Select UTC date and time" />
          <small className="local-time">{formatLocalTime(activeScenario.dateMs)} local</small>
        </label>
        <div className="top-actions">
          <button type="button" onClick={() => setPage("compare")}>Compare</button>
          <button type="button" className={mode === "expert" ? "mode-toggle active" : "mode-toggle"} onClick={() => setMode(mode === "beginner" ? "expert" : "beginner")}>
            {mode === "beginner" ? "Beginner" : "Expert"}
          </button>
          <button type="button" onClick={() => setDetailsOpen(true)}>Details</button>
        </div>
      </header>

      {bundle.manifest.data_kind === "mock" && <div className="mock-strip">Mock terrain data — not a mission verdict.</div>}
      {introOpen && <IntroPanel onDismiss={dismissIntro} />}

      <div className="workspace">
        <section className="main-column" aria-label="Main mission view">
          <div className="view-tabs" role="tablist" aria-label="Mission views">
            {(["sky", "terrain", "map"] as ViewMode[]).map((tab) => (
              <button type="button" role="tab" aria-selected={view === tab} className={view === tab ? "view-tab active" : "view-tab"} onClick={() => setView(tab)} key={tab}>
                {tab === "sky" ? "Sky view" : tab === "terrain" ? "3D view" : "Map"}
              </button>
            ))}
          </div>
          {view === "sky" && <SkyView summary={activeSummary} currentPoint={currentPoint} />}
          {view === "terrain" && <TerrainView bundle={effectiveBundle} site={activeSite} />}
          {view === "map" && <MapView site={activeSite} sites={allSites} onSelect={selectSite} onPickCustom={pickCustomCoordinate} />}
        </section>

        <aside className="status-column" aria-label="Mission status">
          <StatusCard tone="sun" label="Sun" help="The visible fraction is how much of the Sun's disc clears the terrain skyline." status={sunStatusLabel(currentPoint.sunStatus)} value={formatPercent(currentPoint.sunFraction)} exact={mode === "expert" ? `${formatDegrees(currentPoint.sun.el_deg)} elevation · ${formatDegrees(currentPoint.sun.az_deg)} azimuth` : undefined} />
          <StatusCard label={currentPoint.sunStatus === "visible" ? "Time until sunset" : "Time until sunrise"} help="The next time the Sun changes between visible and hidden, based on the current terrain skyline." value={formatDuration(durationUntil(currentPoint.sunStatus === "visible" ? nextSunset : nextSunrise, activeScenario.dateMs))} />
          <StatusCard tone="earth" label="Earth" help="Earth is in view when some of its disc clears the local terrain skyline." status={earthStatusLabel(currentPoint.earthStatus)} value={formatDuration(durationUntil(currentPoint.earthStatus === "visible" ? nextEarthset : nextEarthrise, activeScenario.dateMs))} exact={mode === "expert" ? `${formatDegrees(currentPoint.earth.el_deg)} elevation · ${formatDegrees(currentPoint.earth.az_deg)} azimuth` : undefined} />
          <StatusCard label="Power now" help="Estimated electrical output from the default 4 m² Sun-tracking array at 25% efficiency." value={formatPower(panelPowerW(currentPoint.sun, currentPoint.sunFraction, PANEL))} exact={mode === "expert" ? `${Math.round(currentPoint.batteryWh)} Wh battery · 120 W load` : `Battery ${formatPercent(currentPoint.batteryWh / 2400)}`} />
        </aside>
      </div>

      <Timeline summary={activeSummary} selectedMs={activeScenario.dateMs} playing={playing} onPlay={() => setPlaying((current) => !current)} onChange={updateActiveDate} bounds={bounds} />

      {detailsOpen && <DetailsDrawer
        summary={activeSummary}
        mode={mode}
        customLat={customLat}
        customLon={customLon}
        customMessage={customMessage}
        onClose={() => setDetailsOpen(false)}
        onLatChange={setCustomLat}
        onLonChange={setCustomLon}
        onLoadCustom={addCustomSite}
      />}
    </main>
  );
}

/** Find the timeline sample closest to a selected UTC instant. */
function nearestPoint(points: TimelinePoint[], timeMs: number): TimelinePoint | undefined {
  return points.reduce<TimelinePoint | undefined>((best, point) => !best || Math.abs(point.timeMs - timeMs) < Math.abs(best.timeMs - timeMs) ? point : best, undefined);
}

/** Convert an event timestamp into a non-negative countdown. */
function durationUntil(timeMs: number | undefined, nowMs: number): number | undefined {
  return timeMs === undefined ? undefined : Math.max(0, timeMs - nowMs);
}

/** Describe the three-state Sun result in words for a first-time visitor. */
function sunStatusLabel(status: TimelinePoint["sunStatus"]): string {
  return status === "visible" ? "Visible" : status === "blocked" ? "Hidden" : "Partly hidden";
}

/** Describe the three-state Earth result in words for a first-time visitor. */
function earthStatusLabel(status: TimelinePoint["earthStatus"]): string {
  return status === "visible" ? "In view" : status === "blocked" ? "Out of view" : "Uncertain";
}

/** Explain the south-pole planning problem once, then let the visitor focus on the answer. */
function IntroPanel({ onDismiss }: { onDismiss: () => void }) {
  return <section className="intro-panel"><div><p className="eyebrow">First visit</p><h2>Why the lunar south pole is difficult</h2><p>The Sun and Earth skim the horizon, so small terrain changes can decide whether a landing site has power and contact.</p></div><button type="button" onClick={onDismiss}>Got it</button></section>;
}

/** Render one compact status card with optional exact values for expert mode. */
function StatusCard({ tone, label, status, value, exact, help }: { tone?: "sun" | "earth"; label: string; status?: string; value: string; exact?: string; help: string }) {
  return <article className={`status-card ${tone ?? ""}`}><div className="status-card-heading"><span>{label}</span><Tooltip text={help} /></div>{status && <strong className="status-word">{status}</strong>}<strong className="status-value">{value}</strong>{exact && <small>{exact}</small>}</article>;
}

/** Render the primary sky view with terrain, body paths, and current body positions. */
function SkyView({ summary, currentPoint }: { summary: ScenarioSummary; currentPoint: TimelinePoint }) {
  const width = 720;
  const height = 420;
  const range = elevationRange(summary);
  const skyline = summary.skyline;
  if (!skyline) return <section className="view-panel unavailable">Terrain not included; verdict unavailable.</section>;
  const skylinePoints = skyline.skyline_deg.map((elevation, index) => skyPoint(index * skyline.az_step_deg, elevation, width, height, range.min, range.max));
  const bodyPath = (body: "sun" | "earth") => summary.points.map((point) => {
    const screen = skyPoint(point[body].az_deg, point[body].el_deg, width, height, range.min, range.max);
    return `${screen.x.toFixed(1)},${screen.y.toFixed(1)}`;
  }).join(" ");
  const sunScreen = skyPoint(currentPoint.sun.az_deg, currentPoint.sun.el_deg, width, height, range.min, range.max);
  const earthScreen = skyPoint(currentPoint.earth.az_deg, currentPoint.earth.el_deg, width, height, range.min, range.max);
  return <section className="view-panel sky-panel">
    <div className="view-title"><div><p className="eyebrow">Current sky</p><h1>{summary.site.name}</h1></div><Tooltip text="The terrain line is the highest local obstacle. A body above it can be seen." /></div>
    <svg className="sky-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Skyline with Sun and Earth paths">
      <line x1="0" y1={height - ((0 - range.min) / (range.max - range.min)) * height} x2={width} y2={height - ((0 - range.min) / (range.max - range.min)) * height} className="horizon" />
      <polyline points={skylinePoints.map((point) => `${point.x},${point.y}`).join(" ")} className="skyline-line" />
      <polyline points={bodyPath("sun")} className="sun-path" />
      <polyline points={bodyPath("earth")} className="earth-path" />
      <circle cx={sunScreen.x} cy={sunScreen.y} r={skyBodySize(currentPoint.sun, "sun", height, range.min, range.max)} className="sun-dot" />
      <circle cx={earthScreen.x} cy={earthScreen.y} r={skyBodySize(currentPoint.earth, "earth", height, range.min, range.max)} className="earth-dot" />
    </svg>
    <div className="view-legend"><span className="sun-key">Sun</span><span className="earth-key">Earth</span><span>Terrain skyline</span></div>
  </section>;
}

/** Render a lightweight terrain view from the prepared display-only patch. */
function TerrainView({ bundle, site }: { bundle: DataBundle | undefined; site: Site }) {
  const patch = bundle?.terrain.get(site.id);
  if (!patch) return <section className="view-panel unavailable"><h1>3D view</h1><p>Terrain patch unavailable for this point.</p></section>;
  const size = patch.label.n;
  const samples = Array.from({ length: 11 }, (_, row) => Array.from({ length: 11 }, (_, column) => {
    const sourceRow = Math.round((row / 10) * (size - 1));
    const sourceColumn = Math.round((column / 10) * (size - 1));
    return patch.values[sourceRow * size + sourceColumn] ?? 0;
  }));
  const max = Math.max(...samples.flat(), 1);
  return <section className="view-panel terrain-panel"><div className="view-title"><div><p className="eyebrow">Prepared terrain patch</p><h1>3D view</h1></div><Tooltip text="This display uses the prepared terrain patch. Mission verdicts still come from the skyline." /></div><div className="terrain-grid" style={{ "--terrain-scale": `${max}` } as CSSProperties}>{samples.flatMap((row, rowIndex) => row.map((height, columnIndex) => <span key={`${rowIndex}-${columnIndex}`} style={{ transform: `translateZ(${(height / max) * 18}px)` }} />))}</div><p className="view-caption">{patch.label.size_m.toFixed(0)} m patch · {patch.label.spacing_m.toFixed(0)} m spacing</p></section>;
}

/** Render the data-driven south-polar map and allow selecting sites or a custom point. */
function MapView({ site, sites, onSelect, onPickCustom }: { site: Site; sites: Site[]; onSelect: (siteId: string) => void; onPickCustom: (lat: number, lon: number) => void }) {
  const x = 50 + (site.lon / 180) * 36;
  const y = 50 + ((site.lat + 90) / 10) * 36;
  function handleMapClick(event: MouseEvent<HTMLDivElement>): void {
    const bounds = event.currentTarget.getBoundingClientRect();
    const lon = Math.max(-180, Math.min(180, ((event.clientX - bounds.left) / bounds.width - 0.5) / 0.36 * 180));
    const lat = Math.max(-90, Math.min(-80, -90 + ((event.clientY - bounds.top) / bounds.height - 0.5) / 0.36 * 10));
    onPickCustom(lat, lon);
  }
  return <section className="view-panel map-panel"><div className="view-title"><div><p className="eyebrow">South polar region</p><h1>Map</h1></div><Tooltip text="Select a curated site marker or click anywhere on the polar map to prepare a custom coordinate." /></div><div className="polar-map" onClick={handleMapClick}><div className="polar-grid" />{sites.map((candidate) => <button type="button" className={candidate.id === site.id ? "site-marker selected" : "site-marker"} style={{ left: `${50 + (candidate.lon / 180) * 36}%`, top: `${50 + ((candidate.lat + 90) / 10) * 36}%` }} onClick={(event) => { event.stopPropagation(); onSelect(candidate.id); }} title={candidate.name} aria-label={`Select ${candidate.name}`} key={candidate.id} />)}<span className="site-marker custom-marker" style={{ left: `${x}%`, top: `${y}%` }} aria-hidden="true" /></div><p className="view-caption">{site.lat.toFixed(3)}° latitude · {site.lon.toFixed(3)}° longitude</p></section>;
}

/** Render the single compact timeline and its draggable UTC cursor. */
function Timeline({ summary, selectedMs, playing, onPlay, onChange, bounds }: { summary: ScenarioSummary; selectedMs: number; playing: boolean; onPlay: () => void; onChange: (timeMs: number) => void; bounds: { startMs: number; endMs: number; stepMs: number } | undefined }) {
  const width = 1000;
  const height = 160;
  const values = summary.points.flatMap((point) => [point.sun.el_deg, point.earth.el_deg, 0]);
  const min = Math.min(...values, -2);
  const max = Math.max(...values, 2);
  const x = (index: number) => summary.points.length <= 1 ? 0 : (index / (summary.points.length - 1)) * width;
  const y = (value: number) => height - ((value - min) / (max - min)) * height;
  const line = (body: "sun" | "earth") => summary.points.map((point, index) => `${x(index).toFixed(1)},${y(point[body].el_deg).toFixed(1)}`).join(" ");
  const ratio = bounds ? Math.max(0, Math.min(1, (selectedMs - bounds.startMs) / (bounds.endMs - bounds.startMs))) : 0;
  return <section className="timeline-panel"><div className="timeline-heading"><div><p className="eyebrow">Mission timeline</p><h2>Sunlight and Earth contact</h2></div><Tooltip text="Drag the cursor or press play to move through the selected UTC window." /></div><div className="timeline-plot"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Sun and Earth elevation over time"><line x1="0" y1={y(0)} x2={width} y2={y(0)} className="horizon" /><polyline points={line("sun")} className="sun-path" /><polyline points={line("earth")} className="earth-path" /><line x1={ratio * width} y1="0" x2={ratio * width} y2={height} className="time-cursor" /></svg><div className="timeline-controls"><button type="button" onClick={onPlay}>{playing ? "Pause" : "Play"}</button><input type="range" min="0" max="1000" value={Math.round(ratio * 1000)} onChange={(event) => onChange((bounds?.startMs ?? selectedMs) + (Number(event.target.value) / 1000) * (bounds ? bounds.endMs - bounds.startMs : 0))} aria-label="Timeline cursor" /><time>{new Date(selectedMs).toISOString().replace(".000Z", "Z")}</time></div></div></section>;
}

/** Render a right-side drawer with precision, metrics, and custom coordinate controls. */
function DetailsDrawer({ summary, mode, customLat, customLon, customMessage, onClose, onLatChange, onLonChange, onLoadCustom }: { summary: ScenarioSummary; mode: ExperienceMode; customLat: string; customLon: string; customMessage?: string; onClose: () => void; onLatChange: (value: string) => void; onLonChange: (value: string) => void; onLoadCustom: () => void }) {
  return <aside className="details-drawer" aria-label="Mission details"><div className="drawer-heading"><div><p className="eyebrow">Mission details</p><h2>{mode === "expert" ? "Expert readout" : "Additional information"}</h2></div><button type="button" onClick={onClose} aria-label="Close details">×</button></div><dl className="detail-list"><div><dt>Sunlight in selected window</dt><dd>{summary.sunlightHours.toFixed(1)} h</dd></div><div><dt>Lowest battery</dt><dd>{summary.lowestBatteryWh.toFixed(0)} Wh</dd></div><div><dt>Skyline DEM</dt><dd>{summary.skyline?.dem.join(", ") ?? "Unavailable"}</dd></div><div><dt>Resolution</dt><dd>{summary.skyline?.resolution_m.toFixed(0) ?? "—"} m</dd></div><div><dt>Skyline uncertainty</dt><dd>{summary.skyline ? `${Math.max(...summary.skyline.skyline_err_deg).toFixed(2)}° max` : "—"}</dd></div></dl><div className="drawer-section"><p className="eyebrow">Custom point</p><div className="custom-fields"><label>Latitude<input value={customLat} onChange={(event) => onLatChange(event.target.value)} /></label><label>Longitude<input value={customLon} onChange={(event) => onLonChange(event.target.value)} /></label></div><button type="button" onClick={onLoadCustom}>Load skyline</button>{customMessage && <p className="drawer-message" role="status">{customMessage}</p>}</div></aside>;
}

/** Render the separate scenario comparison page without crowding the dashboard. */
function ComparePage({ scenarios, summaries, activeIndex, onBack, onSelect }: { scenarios: SavedScenario[]; summaries: ScenarioSummary[]; activeIndex: number; onBack: () => void; onSelect: (index: number) => void }) {
  const sunlight = summaries.map((summary) => summary.sunlightHours);
  const battery = summaries.map((summary) => summary.lowestBatteryWh);
  return <main className="app-shell compare-page"><header className="compare-header"><button type="button" onClick={onBack}>← Dashboard</button><div><p className="eyebrow">Scenario comparison</p><h1>Compare mission options</h1></div></header><section className="comparison-card"><table><thead><tr><th>Metric</th>{summaries.map((summary, index) => <th className={index === activeIndex ? "active-column" : ""} key={summary.site.id}>{summary.site.name}</th>)}</tr></thead><tbody><tr><th>Sunlight</th>{summaries.map((summary, index) => <td className={summary.sunlightHours === Math.max(...sunlight) ? "best" : summary.sunlightHours === Math.min(...sunlight) ? "worst" : ""} key={summary.site.id}>{summary.sunlightHours.toFixed(1)} h</td>)}</tr><tr><th>Lowest battery</th>{summaries.map((summary, index) => <td className={summary.lowestBatteryWh === Math.max(...battery) ? "best" : summary.lowestBatteryWh === Math.min(...battery) ? "worst" : ""} key={summary.site.id}>{summary.lowestBatteryWh.toFixed(0)} Wh</td>)}</tr><tr><th>Open scenario</th>{scenarios.map((scenario, index) => <td key={scenario.siteId}><button type="button" onClick={() => { onSelect(index); onBack(); }}>Open</button></td>)}</tr></tbody></table></section></main>;
}

/** Build summaries for the separate comparison page from the same browser engine calls. */
function buildComparisonSummaries(bundle: DataBundle | undefined, scenarios: SavedScenario[], sites: Site[], extraSkylines: Map<string, Skyline>, spanDays: number): ScenarioSummary[] {
  if (!bundle) return [];
  return scenarios.flatMap((scenario) => {
    const site = sites.find((candidate) => candidate.id === scenario.siteId);
    if (!site) return [];
    return [buildTimeline(bundle, site, extraSkylines.get(site.id) ?? bundle.skylines.get(site.id), scenario.dateMs, spanDays)];
  });
}

/** Render a small question-mark tooltip trigger for unfamiliar terms. */
function Tooltip({ text }: { text: string }) {
  return <button className="tooltip-button" type="button" title={text} aria-label={text}>?</button>;
}
