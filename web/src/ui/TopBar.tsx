import type { Overview, Route } from "../state/route";

const OVERVIEWS: { view: Overview; label: string }[] = [
  { view: "globe", label: "Globe" },
  { view: "map", label: "Map" },
];

/**
 * The top bar: the app's name and the one toggle between the two overview scenes.
 *
 * On a site or custom-point scene neither option is pressed; choosing one returns to that
 * overview and keeps the selected time.
 */
export function TopBar({ route, onNavigate }: { route: Route; onNavigate: (route: Route) => void }) {
  return (
    <header className="topbar">
      <a className="topbar-name" href="#/globe">Lunar south pole</a>
      <div className="toggle" role="group" aria-label="Overview">
        {OVERVIEWS.map(({ view, label }) => (
          <button
            key={view}
            type="button"
            className="toggle-option"
            aria-pressed={route.view === view}
            onClick={() => onNavigate({ view, timeMs: route.timeMs })}
          >
            {label}
          </button>
        ))}
      </div>
    </header>
  );
}
