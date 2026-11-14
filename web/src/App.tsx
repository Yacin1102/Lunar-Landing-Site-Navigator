import { useState } from "react";

// Render the initial shell while the data-loading layer is built in the next task.
export default function App() {
  const [selectedSite, setSelectedSite] = useState("No site selected");

  return (
    <main className="app-shell">
      <header className="hero">
        <p className="eyebrow">NASA Space Apps · lunar south pole</p>
        <h1>Lunar Landing Site Navigator</h1>
        <p className="lede">
          A precision-first view of sunlight, Earth visibility, and mission power windows.
        </p>
      </header>
      <section className="card">
        <p className="status-pill">Web engine scaffold ready</p>
        <h2>{selectedSite}</h2>
        <button type="button" onClick={() => setSelectedSite("Site data will load next")}>
          Check prepared data
        </button>
      </section>
    </main>
  );
}
