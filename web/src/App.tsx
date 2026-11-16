import type { DataBundle } from "../engine/runtime-types";
import { useData } from "./state/useData";
import { useRoute } from "./state/useRoute";
import type { Route } from "./state/route";
import { TopBar } from "./ui/TopBar";
import { SiteList } from "./ui/SiteList";
import { SiteSummary } from "./ui/SiteSummary";
import { PointSummary } from "./ui/PointSummary";
import { Stage } from "./ui/Stage";

/**
 * The application shell.
 *
 * Role: load the engine's prepared data once, read the route from the URL, and lay out the three
 * fixed regions: a quiet top bar, the stage (where the imagery goes) and one side panel.
 *
 * How it works: `useData` reports loading, error or ready. Until the data is ready nothing but a
 * status line is shown, so no number can appear that did not come from a checked file. When the
 * manifest says the folder holds mock data, a banner says so on every screen (handoff rule 3).
 */
export default function App() {
  const data = useData();
  const [route, navigate] = useRoute();

  if (data.status === "loading") {
    return (
      <div className="app">
        <TopBar route={route} onNavigate={navigate} />
        <p className="status" role="status">Loading the prepared lunar data…</p>
      </div>
    );
  }

  if (data.status === "error") {
    return (
      <div className="app">
        <TopBar route={route} onNavigate={navigate} />
        <div className="status" role="alert">
          <h1>The prepared data could not be loaded</h1>
          <p>{data.message}</p>
          <p>Nothing is shown, because every number in this app must come from a checked file. Reload the page to try again.</p>
        </div>
      </div>
    );
  }

  const { bundle } = data;
  return (
    <div className="app">
      <TopBar route={route} onNavigate={navigate} />
      {bundle.manifest.data_kind === "mock" && (
        <p className="mock-banner" role="alert">Mock data: invented terrain. Nothing on this screen is a real verdict.</p>
      )}
      <div className="workspace">
        <Stage route={route} />
        <aside className="panel" aria-label={panelLabel(route)}>
          <Panel route={route} bundle={bundle} onNavigate={navigate} />
        </aside>
      </div>
    </div>
  );
}

/** Name the side panel for screen readers according to what it holds. */
function panelLabel(route: Route): string {
  if (route.view === "site") return "Site";
  if (route.view === "point") return "Custom point";
  return "Sites";
}

/** The one side panel: the site list on the overview scenes, a summary on the site scenes. */
function Panel({ route, bundle, onNavigate }: { route: Route; bundle: DataBundle; onNavigate: (route: Route) => void }) {
  if (route.view === "site") return <SiteSummary siteId={route.siteId} bundle={bundle} timeMs={route.timeMs} />;
  if (route.view === "point") return <PointSummary lat={route.lat} lon={route.lon} bundle={bundle} timeMs={route.timeMs} />;
  return <SiteList sites={bundle.sites} onOpen={(siteId) => onNavigate({ view: "site", siteId, timeMs: route.timeMs })} />;
}
