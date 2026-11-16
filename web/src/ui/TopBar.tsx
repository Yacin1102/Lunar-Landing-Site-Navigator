import type { Overview, Route } from "../state/route";

const OVERVIEWS: { view: Overview; label: string }[] = [
  { view: "globe", label: "Globe" },
  { view: "map", label: "Map" },
];

/**
 * The top bar: the app's name, the one toggle between the two overview scenes, and About.
 *
 * On a site or custom-point scene neither overview is pressed; choosing one returns to it and
 * keeps the selected time. About replaces the side panel's content, so only one panel is open.
 */
export function TopBar({ route, onNavigate, about, onAbout }: { route: Route; onNavigate: (route: Route) => void; about: boolean; onAbout: () => void }) {
  return (
    <header className="topbar">
      <a className="topbar-name" href="#/globe">Lunar south pole</a>
      <div className="topbar-actions">
        <div className="toggle" role="group" aria-label="Overview">
          {OVERVIEWS.map(({ view, label }) => (
            <button key={view} type="button" className="toggle-option" aria-pressed={route.view === view} onClick={() => onNavigate({ view })}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="button button-quiet" aria-pressed={about} onClick={onAbout}>About</button>
      </div>
    </header>
  );
}
