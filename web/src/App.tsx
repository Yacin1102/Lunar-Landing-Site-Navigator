import { useEffect, useMemo, useState } from "react";
import { evaluateInWorker } from "../engine/client";
import { loadDataBundle } from "../engine/data";
import type { DataBundle, Direction } from "../engine/runtime-types";
import type { Site, Skyline } from "../engine/types";
import { fetchCustomSkyline } from "./api";
import { fromDateTimeInputValue, buildTimeline, elevationRange, formatDuration, skyBodySize, skyElevation, skyPoint, timelineBounds, toDateTimeInputValue, type ScenarioSummary } from "./visual-model";
import { readSavedScenarios, saveScenariosToUrl, type SavedScenario } from "./url-state";

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

/** Render the mission-planning dashboard while keeping all astronomy in the existing engine. */
export default function App() {
  const [bundle, setBundle] = useState<DataBundle>();
  const [loadError, setLoadError] = useState<string>();
  const [extraSites, setExtraSites] = useState<ExtraSite[]>([]);
  const [scenarios, setScenarios] = useState<SavedScenario[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [customLat, setCustomLat] = useState("-89");
  const [customLon, setCustomLon] = useState("0");
  const [customMessage, setCustomMessage] = useState<string>();
  const [spanDays, setSpanDays] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [workerResult, setWorkerResult] = useState<WorkerResult>();

  useEffect(() => {
    loadDataBundle()
      .then((loaded) => {
        setBundle(loaded);
        const saved = readSavedScenarios().filter((scenario) => loaded.sites.some((site) => site.id === scenario.siteId));
        const initialDate = loaded.ephemeris.label.t0_ms + 12 * 3600000;
        const initial = saved.length ? saved : [{ siteId: loaded.sites[0]?.id ?? "", dateMs: initialDate }];
        setScenarios(initial.slice(0, 4));
        setSelectedSiteId(loaded.sites[0]?.id ?? "");
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
    return {
      ...bundle,
      sites: allSites,
      skylines: new Map([...bundle.skylines, ...extraSkylineMap]),
    };
  }, [allSites, bundle, extraSkylineMap]);
  const activeSummary = useMemo(
    () => effectiveBundle && activeSite && activeScenario
      ? buildTimeline(effectiveBundle, activeSite, activeSkyline, activeScenario.dateMs, spanDays)
      : undefined,
    [activeScenario, activeSite, activeSkyline, effectiveBundle, spanDays],
  );
  const comparisonSummaries = useMemo(
    () => effectiveBundle
      ? scenarios.flatMap((scenario) => {
        const site = allSites.find((candidate) => candidate.id === scenario.siteId);
        if (!site) return [];
        return [buildTimeline(effectiveBundle, site, extraSkylineMap.get(site.id) ?? bundle?.skylines.get(site.id), scenario.dateMs, spanDays)];
      })
      : [],
    [allSites, bundle?.skylines, effectiveBundle, extraSkylineMap, scenarios, spanDays],
  );
  const bounds = activeScenario ? timelineBounds(activeScenario.dateMs, spanDays) : undefined;

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
        ? { ...scenario, dateMs: scenario.dateMs + bounds.stepMs }
        : scenario));
    }, 250);
    return () => window.clearInterval(timer);
  }, [activeIndex, activeScenario, bounds, playing]);

  /** Add a curated site to the comparison set without duplicating an existing scenario. */
  function addScenario(siteId: string): void {
    if (!siteId || scenarios.some((scenario) => scenario.siteId === siteId) || scenarios.length >= 4) return;
    const dateMs = activeScenario?.dateMs ?? bundle?.ephemeris.label.t0_ms ?? Date.now();
    setScenarios((current) => [...current, { siteId, dateMs }]);
    setActiveIndex(scenarios.length);
  }

  /** Remove one comparison scenario and keep the active tab within bounds. */
  function removeScenario(index: number): void {
    setScenarios((current) => current.filter((_, candidateIndex) => candidateIndex !== index));
    setActiveIndex((current) => Math.max(0, Math.min(current, scenarios.length - 2)));
  }

  /** Request a custom skyline and add it only when the API gives a valid answer. */
  async function addCustomSite(): Promise<void> {
    const lat = Number(customLat);
    const lon = Number(customLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > -80 || lon < -180 || lon > 180) {
      setCustomMessage("Use a south-polar latitude from -90° to -80° and longitude from -180° to 180°.");
      return;
    }
    setCustomMessage("Requesting terrain skyline…");
    const result = await fetchCustomSkyline(API_BASE, lat, lon);
    if (!result.ok) {
      setCustomMessage(result.message);
      return;
    }
    const id = `custom_${lat.toFixed(4)}_${lon.toFixed(4)}`.replace("-", "m").replace(".", "p");
    const site: Site = { id, name: `Custom ${lat.toFixed(3)}°, ${lon.toFixed(3)}°`, lat, lon, category: "custom", has_terrain: false, has_shade_grid: false };
    setExtraSites((current) => [...current.filter((entry) => entry.site.id !== id), { site, skyline: result.skyline }]);
    setScenarios((current) => [...current.filter((scenario) => scenario.siteId !== id), { siteId: id, dateMs: activeScenario?.dateMs ?? Date.now() }].slice(0, 4));
    setActiveIndex(Math.min(scenarios.length, 3));
    setCustomMessage("Custom skyline loaded. Terrain view is unavailable for custom points.");
  }

  /** Move one scenario's selected instant when the date input or timeline changes. */
  function updateActiveDate(dateMs: number): void {
    if (!activeScenario || !Number.isFinite(dateMs)) return;
    setScenarios((current) => current.map((scenario, index) => index === activeIndex ? { ...scenario, dateMs } : scenario));
  }

  if (loadError) return <main className="app-shell"><aside className="banner error" role="alert">{loadError}</aside></main>;
  if (!bundle || !activeScenario || !activeSite || !activeSummary) return <main className="app-shell"><p className="loading">Loading prepared mission data…</p></main>;

  const nextSunset = workerResult?.events?.sunset.find((time) => time >= activeScenario.dateMs) ?? (activeSummary.timeToSunsetMs === undefined ? undefined : activeScenario.dateMs + activeSummary.timeToSunsetMs);
  const nextEarthset = workerResult?.events?.earthset.find((time) => time >= activeScenario.dateMs) ?? (activeSummary.timeToEarthsetMs === undefined ? undefined : activeScenario.dateMs + activeSummary.timeToEarthsetMs);
  const timeToSunset = nextSunset === undefined ? undefined : nextSunset - activeScenario.dateMs;
  const timeToEarthset = nextEarthset === undefined ? undefined : nextEarthset - activeScenario.dateMs;
  const scrubRatio = bounds ? Math.max(0, Math.min(1, (activeScenario.dateMs - bounds.startMs) / (bounds.endMs - bounds.startMs))) : 0;

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">NASA Space Apps · lunar south pole</p>
          <h1>Lunar Landing Site Navigator</h1>
          <p className="lede">Plan sunlight, Earth visibility, and battery margins without hiding uncertainty.</p>
        </div>
        {bundle.manifest.data_kind === "mock" && <aside className="banner compact" role="status">Mock terrain data — not a mission verdict.</aside>}
      </header>

      <section className="control-panel card">
        <div className="section-heading"><div><p className="eyebrow">1 · Where and when</p><h2>Mission scenario</h2></div><span className="help" title="A scenario is one site viewed at one UTC instant. Add up to four to compare mission options.">ⓘ</span></div>
        <div className="scenario-tabs" role="tablist" aria-label="Saved scenarios">
          {scenarios.map((scenario, index) => (
            <button className={index === activeIndex ? "tab active" : "tab"} key={`${scenario.siteId}-${index}`} onClick={() => setActiveIndex(index)} type="button">
              {allSites.find((site) => site.id === scenario.siteId)?.name ?? scenario.siteId}
              {scenarios.length > 1 && <span className="tab-remove" onClick={(event) => { event.stopPropagation(); removeScenario(index); }} aria-label="Remove scenario">×</span>}
            </button>
          ))}
        </div>
        <div className="form-grid">
          <label>Curated site <select value={selectedSiteId} onChange={(event) => setSelectedSiteId(event.target.value)}><option value="">Choose a site…</option>{bundle.sites.map((site) => <option key={site.id} value={site.id}>{site.name} · {site.category}</option>)}</select></label>
          <button type="button" onClick={() => addScenario(selectedSiteId)} disabled={!selectedSiteId || scenarios.length >= 4}>Add to comparison</button>
          <label>UTC date and time <input type="datetime-local" value={toDateTimeInputValue(activeScenario.dateMs)} onChange={(event) => updateActiveDate(fromDateTimeInputValue(event.target.value))} /></label>
          <label>Timeline span <select value={spanDays} onChange={(event) => setSpanDays(Number(event.target.value))}><option value={1}>One lunar day · 24 hours</option><option value={30}>One month</option><option value={90}>Three months</option></select></label>
        </div>
        <div className="custom-row">
          <label>Custom latitude <input value={customLat} onChange={(event) => setCustomLat(event.target.value)} inputMode="decimal" /></label>
          <label>Custom longitude <input value={customLon} onChange={(event) => setCustomLon(event.target.value)} inputMode="decimal" /></label>
          <button type="button" onClick={addCustomSite}>Load custom skyline</button>
          {customMessage && <span className="inline-message" role="status">{customMessage}</span>}
        </div>
        <div className="scrubber">
          <button type="button" className="play" onClick={() => setPlaying((current) => !current)}>{playing ? "Pause" : "Play timeline"}</button>
          <input aria-label="Timeline position" type="range" min="0" max="1000" value={Math.round(scrubRatio * 1000)} onChange={(event) => updateActiveDate((bounds?.startMs ?? activeScenario.dateMs) + (Number(event.target.value) / 1000) * (bounds ? bounds.endMs - bounds.startMs : 0))} />
          <time>{new Date(activeScenario.dateMs).toISOString().replace(".000Z", "Z")}</time>
        </div>
      </section>

      <section className="countdown-grid" aria-label="Countdowns">
        <CountdownCard label="Time to sunset" value={formatDuration(timeToSunset)} explanation="How long until the Sun's upper edge drops below the terrain skyline." />
        <CountdownCard label="Time to Earthset" value={formatDuration(timeToEarthset)} explanation="How long until the Earth becomes hidden by the local terrain." />
        <CountdownCard label="Sunlight in this window" value={`${activeSummary.sunlightHours.toFixed(1)} h`} explanation="Total time classified as visibly lit in the selected timeline." />
        <CountdownCard label="Lowest battery" value={`${activeSummary.lowestBatteryWh.toFixed(0)} Wh`} explanation="The lowest simulated charge for a 4 m² tracking array, 25% efficient, under a 120 W load." />
      </section>

      <section className="dashboard-grid">
        <SkyView summary={activeSummary} />
        <TimelineChart summary={activeSummary} />
      </section>

      <ComparisonTable summaries={comparisonSummaries} activeIndex={activeIndex} />
    </main>
  );
}

/** Explain one mission number with a prominent value and plain-language tooltip. */
function CountdownCard({ label, value, explanation }: { label: string; value: string; explanation: string }) {
  return <article className="countdown-card card" title={explanation}><p>{label} <span className="help">ⓘ</span></p><strong>{value}</strong><small>{explanation}</small></article>;
}

/** Draw the skyline silhouette and body positions/paths in the local north-clockwise sky. */
function SkyView({ summary }: { summary: ScenarioSummary }) {
  const width = 720;
  const height = 300;
  const range = elevationRange(summary);
  const skyline = summary.skyline;
  if (!skyline) return <section className="card panel"><h2>Sky view</h2><p className="unavailable">Terrain not included; verdict unavailable.</p></section>;
  const skylinePoints = skyline.skyline_deg.map((elevation, index) => skyPoint(index * skyline.az_step_deg, elevation, width, height, range.min, range.max));
  const bodyPath = (body: "sun" | "earth") => summary.points.map((point) => {
    const screen = skyPoint(point[body].az_deg, point[body].el_deg, width, height, range.min, range.max);
    return `${screen.x.toFixed(1)},${screen.y.toFixed(1)}`;
  }).join(" ");
  const sun = summary.points[Math.floor(summary.points.length / 2)]?.sun;
  const earth = summary.points[Math.floor(summary.points.length / 2)]?.earth;
  const sunScreen = sun ? skyPoint(sun.az_deg, sun.el_deg, width, height, range.min, range.max) : undefined;
  const earthScreen = earth ? skyPoint(earth.az_deg, earth.el_deg, width, height, range.min, range.max) : undefined;
  return <section className="card panel"><div className="section-heading"><div><p className="eyebrow">2 · Sky view</p><h2>Terrain and body paths</h2></div><span className="help" title="The white silhouette is the terrain skyline. A body above it can be seen; paths show how azimuth and elevation change over the selected window.">ⓘ</span></div>
    <svg className="sky-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Skyline silhouette with Sun and Earth paths">
      <line x1="0" y1={height - ((0 - range.min) / (range.max - range.min)) * height} x2={width} y2={height - ((0 - range.min) / (range.max - range.min)) * height} className="horizon" />
      <polyline points={skylinePoints.map((point) => `${point.x},${point.y}`).join(" ")} className="skyline-line" />
      <polyline points={bodyPath("sun")} className="sun-path" />
      <polyline points={bodyPath("earth")} className="earth-path" />
      {sunScreen && sun && <circle cx={sunScreen.x} cy={sunScreen.y} r={skyBodySize(sun, "sun", height, range.min, range.max)} className="sun-dot"><title>Sun: {sun.el_deg.toFixed(2)}° elevation</title></circle>}
      {earthScreen && earth && <circle cx={earthScreen.x} cy={earthScreen.y} r={skyBodySize(earth, "earth", height, range.min, range.max)} className="earth-dot"><title>Earth: {earth.el_deg.toFixed(2)}° elevation</title></circle>}
    </svg>
    <div className="legend"><span><i className="legend-sun" />Sun</span><span><i className="legend-earth" />Earth</span><span><i className="legend-skyline" />Terrain skyline</span><span className="muted">0° is local level</span></div>
    <p className="microcopy">At the selected instant, terrain is {skyElevation(skyline, sun?.az_deg ?? 0).toFixed(2)}° high toward the Sun. <span className="help" title="Skyline elevation is measured above the local level plane; negative values mean the curved horizon is below level.">ⓘ</span></p>
  </section>;
}

/** Draw elevation traces, lit/visible shading, and the simulated battery charge. */
function TimelineChart({ summary }: { summary: ScenarioSummary }) {
  const width = 720;
  const height = 300;
  const values = summary.points.flatMap((point) => [point.sun.el_deg, point.earth.el_deg, 0]);
  const min = Math.min(...values, -2);
  const max = Math.max(...values, 2);
  const x = (index: number) => summary.points.length <= 1 ? 0 : (index / (summary.points.length - 1)) * width;
  const y = (value: number) => height - ((value - min) / (max - min)) * height;
  const line = (body: "sun" | "earth") => summary.points.map((point, index) => `${x(index).toFixed(1)},${y(point[body].el_deg).toFixed(1)}`).join(" ");
  const batteryLine = summary.points.map((point, index) => `${x(index).toFixed(1)},${height - (point.batteryWh / 2400) * height}`).join(" ");
  return <section className="card panel"><div className="section-heading"><div><p className="eyebrow">3 · Timeline</p><h2>Elevation, visibility, and charge</h2></div><span className="help" title="Elevation is the angle above local level. Shaded bands indicate periods classified as visible; the amber line is stored energy.">ⓘ</span></div>
    <svg className="timeline-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Sun and Earth elevation timeline">
      {summary.points.map((point, index) => <g key={point.timeMs}><rect x={x(index)} y="0" width={Math.max(1, width / Math.max(1, summary.points.length - 1))} height={height} className={point.sunStatus === "visible" ? "lit-band" : point.earthStatus === "visible" ? "earth-band" : ""} /></g>)}
      <line x1="0" y1={y(0)} x2={width} y2={y(0)} className="horizon" />
      <polyline points={line("sun")} className="sun-path" />
      <polyline points={line("earth")} className="earth-path" />
      <polyline points={batteryLine} className="battery-path" />
    </svg>
    <div className="legend"><span><i className="legend-sun" />Sun elevation</span><span><i className="legend-earth" />Earth elevation</span><span><i className="legend-battery" />Battery charge</span></div>
  </section>;
}

/** Compare up to four scenario summaries and highlight the best/worst metric values. */
function ComparisonTable({ summaries, activeIndex }: { summaries: ScenarioSummary[]; activeIndex: number }) {
  if (summaries.length < 2) return null;
  const sunlight = summaries.map((summary) => summary.sunlightHours);
  const battery = summaries.map((summary) => summary.lowestBatteryWh);
  const bestSun = Math.max(...sunlight);
  const worstSun = Math.min(...sunlight);
  const bestBattery = Math.max(...battery);
  const worstBattery = Math.min(...battery);
  return <section className="card comparison"><div className="section-heading"><div><p className="eyebrow">4 · Compare</p><h2>Mission scenarios</h2></div><span className="help" title="Best and worst highlights compare only the scenarios currently saved in this page URL.">ⓘ</span></div>
    <div className="table-scroll"><table><thead><tr><th>Metric</th>{summaries.map((summary, index) => <th className={index === activeIndex ? "active-column" : ""} key={summary.site.id}>{summary.site.name}</th>)}</tr></thead>
      <tbody>
        <MetricRow label="Sunlight hours" values={summaries.map((summary) => `${summary.sunlightHours.toFixed(1)} h`)} numbers={sunlight} best={bestSun} worst={worstSun} higherIsBetter />
        <MetricRow label="Lowest battery" values={summaries.map((summary) => `${summary.lowestBatteryWh.toFixed(0)} Wh`)} numbers={battery} best={bestBattery} worst={worstBattery} higherIsBetter />
        <MetricRow label="Data source" values={summaries.map((summary) => summary.skyline?.dem.join(", ") ?? "Unavailable")} />
      </tbody></table></div>
  </section>;
}

/** Render one comparison metric and mark its best and worst values. */
function MetricRow({ label, values, numbers, best, worst, higherIsBetter }: { label: string; values: string[]; numbers?: number[]; best?: number; worst?: number; higherIsBetter?: boolean }) {
  return <tr><th>{label}</th>{values.map((value, index) => {
    const number = numbers?.[index];
    const isBest = number !== undefined && number === (higherIsBetter ? best : worst);
    const isWorst = number !== undefined && number === (higherIsBetter ? worst : best);
    return <td className={isBest ? "best" : isWorst ? "worst" : ""} key={`${label}-${index}`}>{value}</td>;
  })}</tr>;
}
