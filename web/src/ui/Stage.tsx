import { lazy, Suspense } from "react";
import { directionsAt } from "../../engine/astro";
import type { DataBundle } from "../../engine/runtime-types";
import { visibleDiscFraction } from "../../engine/visibility";
import type { Route } from "../state/route";
import { PolarMap } from "../scenes/PolarMap";
import { Sky } from "../scenes/Sky";
import { GeometryView } from "../scenes/GeometryView";

// The two three.js scenes are loaded when first shown, so the map and the panel appear sooner.
const Globe = lazy(() => import("../scenes/Globe").then((module) => ({ default: module.Globe })));
const Terrain = lazy(() => import("../scenes/Terrain").then((module) => ({ default: module.Terrain })));

export type SiteTab = "terrain" | "sky" | "geometry";
const TAB_LABEL: Record<SiteTab, string> = { terrain: "Terrain", sky: "Sky", geometry: "Geometry" };

/**
 * The stage's scene area: picks the scene for the route and, on a site or a custom point, shows
 * the tabs that switch between terrain, sky and geometry.
 *
 * A curated site with a terrain patch gets all three. A custom point has no terrain data, so it
 * gets the sky and the geometry only; the side panel says why.
 */
export function Stage({
  route, bundle, timeMs, tab, onTab, onOpenSite,
}: {
  route: Route; bundle: DataBundle; timeMs: number; tab: SiteTab; onTab: (tab: SiteTab) => void; onOpenSite: (siteId: string) => void;
}) {
  const { label, values } = bundle.ephemeris;
  let tabs: SiteTab[] = [];
  let scene = <p className="stage-pending">Nothing to show for this address. Choose a site from the list.</p>;

  if (route.view === "globe") scene = <Globe bundle={bundle} timeMs={timeMs} onOpen={onOpenSite} />;
  else if (route.view === "map") scene = <PolarMap bundle={bundle} onOpen={onOpenSite} />;
  else if (route.view === "site") {
    const site = bundle.sites.find((candidate) => candidate.id === route.siteId);
    const skyline = bundle.skylines.get(route.siteId);
    const terrain = bundle.terrain.get(route.siteId);
    if (site && skyline) {
      tabs = terrain ? ["terrain", "sky", "geometry"] : ["sky", "geometry"];
      const shown = route.probe ? "sky" : tabs.includes(tab) ? tab : tabs[0];
      const sun = directionsAt(values, label, timeMs, site.lat, site.lon, skyline.elev_m, skyline.mast_m).sun;
      if (shown === "terrain" && terrain) {
        scene = <Terrain key={site.id} terrain={terrain} shade={bundle.shade.get(site.id)} sun={sun} sunFraction={visibleDiscFraction(sun, "sun", skyline, 0)} />;
      } else if (shown === "sky") {
        scene = <Sky key={site.id} bundle={bundle} lat={site.lat} lon={site.lon} elevM={skyline.elev_m} mastM={skyline.mast_m} skyline={skyline} timeMs={timeMs} probe={route.probe} />;
      } else scene = <GeometryView bundle={bundle} timeMs={timeMs} />;
      tab = shown;
    }
  } else if (route.view === "point") {
    const region = bundle.manifest.service_region;
    if (route.lat >= region.lat_min && route.lat <= region.lat_max && route.lon >= -180 && route.lon <= 180) {
      tabs = ["sky", "geometry"];
      const shown = route.probe || tab !== "geometry" ? "sky" : "geometry";
      scene = shown === "sky"
        ? <Sky key={`${route.lat},${route.lon}`} bundle={bundle} lat={route.lat} lon={route.lon} elevM={0} mastM={0} timeMs={timeMs} probe={route.probe} />
        : <GeometryView bundle={bundle} timeMs={timeMs} />;
      tab = shown;
    }
  }

  return (
    <div className="stage-scene">
      <Suspense fallback={<p className="stage-pending">Loading the scene…</p>}>{scene}</Suspense>
      {tabs.length > 0 && !route.probe && (
        <div className="toggle stage-tabs" role="group" aria-label="View">
          {tabs.map((name) => (
            <button key={name} type="button" className="toggle-option" aria-pressed={tab === name} onClick={() => onTab(name)}>{TAB_LABEL[name]}</button>
          ))}
        </div>
      )}
    </div>
  );
}
