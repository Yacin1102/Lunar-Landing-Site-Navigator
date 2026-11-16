import type { DataBundle } from "../../engine/runtime-types";
import { formatRoute } from "../state/route";
import { formatLatLon } from "../lib/sites";
import { Facts } from "./Facts";

/**
 * Side panel for a custom point (coordinates the user typed, not a curated site).
 *
 * No terrain skyline exists for such a point, so the app can show where the Sun and Earth are
 * but must not say whether the point is lit. The panel states that limit in one line. A point
 * outside the service region of the manifest is refused with the region's real bounds.
 */
export function PointSummary({ lat, lon, bundle, timeMs }: { lat: number; lon: number; bundle: DataBundle; timeMs?: number }) {
  const back = formatRoute({ view: "globe", timeMs });
  const region = bundle.manifest.service_region;
  const inRegion = lat >= region.lat_min && lat <= region.lat_max && lon >= -180 && lon <= 180;

  if (!inRegion) {
    return (
      <div className="panel-body">
        <a className="back" href={back}>All sites</a>
        <h1 className="panel-title">Outside the south polar region</h1>
        <p className="panel-lead">
          This app covers latitudes from {Math.abs(region.lat_max)}° S to {Math.abs(region.lat_min)}° S and longitudes from
          180° W to 180° E. The address asks for latitude {lat}°, longitude {lon}°.
        </p>
      </div>
    );
  }

  return (
    <div className="panel-body">
      <a className="back" href={back}>All sites</a>
      <h1 className="panel-title">Custom point</h1>
      <p className="panel-lead">
        No terrain skyline exists for this point, so the app cannot say whether it is lit. 3D terrain and lit or blocked
        answers exist only for the curated sites.
      </p>
      <Facts facts={[{ label: "Position", value: formatLatLon(lat, lon) }]} />
    </div>
  );
}
