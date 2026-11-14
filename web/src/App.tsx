import { useEffect, useState } from "react";
import { loadDataBundle } from "../engine/data";
import type { DataBundle } from "../engine/runtime-types";

// Render the site menu and make the prepared-data state visible to mission planners.
export default function App() {
  const [bundle, setBundle] = useState<DataBundle>();
  const [error, setError] = useState<string>();
  const [selectedSite, setSelectedSite] = useState<string>();

  useEffect(() => {
    loadDataBundle().then(setBundle).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Prepared data could not be loaded.");
    });
  }, []);

  return (
    <main className="app-shell">
      <header className="hero">
        <p className="eyebrow">NASA Space Apps · lunar south pole</p>
        <h1>Lunar Landing Site Navigator</h1>
        <p className="lede">
          A precision-first view of sunlight, Earth visibility, and mission power windows.
        </p>
      </header>
      {bundle?.manifest.data_kind === "mock" && (
        <aside className="banner" role="status">
          Mock terrain data — verdicts are for interface testing, not mission decisions.
        </aside>
      )}
      {error && (
        <aside className="banner error" role="alert">
          Prepared data unavailable: {error}
        </aside>
      )}
      <section className="card">
        <p className="status-pill">{bundle ? `${bundle.sites.length} sites loaded` : "Loading prepared data"}</p>
        <h2>{selectedSite ? bundle?.sites.find((site) => site.id === selectedSite)?.name : "Choose a site"}</h2>
        {bundle && (
          <ul className="site-list">
            {bundle.sites.map((site) => (
              <li key={site.id}>
                <button type="button" onClick={() => setSelectedSite(site.id)}>
                  {site.name}
                </button>
                <span>{site.lat.toFixed(3)}°, {site.lon.toFixed(3)}°</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
