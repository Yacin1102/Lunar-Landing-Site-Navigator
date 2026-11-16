import type { ReactNode } from "react";
import type { Site } from "../../engine/types";
import { categoryHeading, formatLatLon, groupByCategory } from "../lib/sites";

/**
 * The curated sites from `sites.json`, grouped by category. Choosing one opens its site view.
 * Names, coordinates and groups all come from the file; nothing here is typed in.
 */
export function SiteList({ sites, onOpen, children }: { sites: Site[]; onOpen: (siteId: string) => void; children?: ReactNode }) {
  return (
    <div className="panel-body">
      <h1 className="panel-title">Sites</h1>
      <p className="panel-lead">{sites.length} south polar sites with a computed skyline. Choose one to open it.</p>
      {groupByCategory(sites).map((group) => (
        <section key={group.category} className="site-group">
          <h2 className="group-title">{categoryHeading(group.category)}</h2>
          <ul className="site-list">
            {group.sites.map((site) => (
              <li key={site.id}>
                <button type="button" className="site-row" onClick={() => onOpen(site.id)}>
                  <span className="site-name">{site.name}</span>
                  <span className="site-coords">{formatLatLon(site.lat, site.lon)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {children}
    </div>
  );
}
