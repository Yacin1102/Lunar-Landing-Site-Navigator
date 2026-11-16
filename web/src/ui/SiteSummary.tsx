import type { DataBundle } from "../../engine/runtime-types";
import { MOON_RADIUS_M } from "../../engine/types";
import { formatRoute } from "../state/route";
import { categoryHeading, formatLatLon } from "../lib/sites";
import { Facts, type Fact } from "./Facts";
import { SiteReadouts, type PowerSettings } from "./Readouts";

/**
 * Side panel for a curated site: the readouts for the selected time, where the site is, and
 * which data its answers rest on.
 *
 * Every value is read from the site's record in `sites.json` and from its skyline record
 * (ground height, eye height, source maps, map resolution, uncertainty). An id that is not in
 * `sites.json` gets a plain explanation and a way back.
 */
export function SiteSummary({
  siteId, bundle, timeMs, windowStartMs, windowEndMs, power, onPower,
}: {
  siteId: string; bundle: DataBundle; timeMs: number; windowStartMs: number; windowEndMs: number; power: PowerSettings; onPower: (next: PowerSettings) => void;
}) {
  const back = formatRoute({ view: "globe", timeMs });
  const site = bundle.sites.find((candidate) => candidate.id === siteId);
  const skyline = bundle.skylines.get(siteId);

  if (!site || !skyline) {
    return (
      <div className="panel-body">
        <a className="back" href={back}>All sites</a>
        <h1 className="panel-title">No such site</h1>
        <p className="panel-lead">There is no site with the id “{siteId}” in the prepared data. Choose one from the list.</p>
      </div>
    );
  }

  const largestError = skyline.skyline_err_deg.reduce((largest, value) => Math.max(largest, value), 0);
  const facts: Fact[] = [
    { label: "Position", value: formatLatLon(site.lat, site.lon) },
    { label: "Ground height", value: `${skyline.elev_m.toFixed(1)} m above the ${MOON_RADIUS_M / 1000} km sphere` },
    { label: "Eye height", value: `${skyline.mast_m.toFixed(1)} m above the ground` },
    { label: "Group", value: categoryHeading(site.category) },
  ];
  if (site.mission) facts.push({ label: "Mission", value: site.mission });
  if (site.country) facts.push({ label: "Agency", value: site.country });
  if (site.date_utc) facts.push({ label: "Date", value: `${site.date_utc} UTC` });

  const provenance: Fact[] = [
    { label: "Elevation maps", value: skyline.dem.join(", ") },
    { label: "Finest map pixel", value: `${skyline.resolution_m} m` },
    { label: "Skyline step", value: `${skyline.az_step_deg}° of azimuth` },
    { label: "Skyline uncertainty", value: `up to ±${largestError.toFixed(3)}°` },
  ];

  return (
    <div className="panel-body">
      <a className="back" href={back}>All sites</a>
      <h1 className="panel-title">{site.name}</h1>
      {site.notes && <p className="panel-lead">{site.notes}</p>}
      <SiteReadouts bundle={bundle} site={site} skyline={skyline} timeMs={timeMs} windowStartMs={windowStartMs} windowEndMs={windowEndMs} power={power} onPower={onPower} />
      <h2 className="group-title">Site</h2>
      <Facts facts={facts} />
      <h2 className="group-title">Data behind this site</h2>
      <Facts facts={provenance} />
    </div>
  );
}
