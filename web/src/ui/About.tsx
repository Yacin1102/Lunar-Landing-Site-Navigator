import { useEffect, useState } from "react";
import type { DataBundle } from "../../engine/runtime-types";
import { formatUtc } from "../formatting";

interface AssetRecord {
  path: string;
  credit: string;
  what: string;
  image_time?: string | null;
  source: { url: string; downloaded_utc: string };
}

/**
 * The About panel: what the app answers, where its numbers and pictures come from, and what is
 * approximate. Image credits are read from assets.json, the same record the asset script wrote,
 * so the panel cannot drift from the files that are actually shipped.
 */
export function About({ bundle, onClose }: { bundle: DataBundle; onClose: () => void }) {
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  useEffect(() => {
    fetch("/assets/assets.json").then((response) => response.json()).then((manifest: { assets: AssetRecord[] }) => setAssets(manifest.assets), () => undefined);
  }, []);
  const groups = [
    { title: "Moon colour and elevation", match: "moon/" },
    { title: "South pole shaded relief", match: "hillshade/" },
    { title: "Sun", match: "sun/" },
    { title: "Earth", match: "earth/bmng_01" },
  ];
  const { label } = bundle.ephemeris;
  return (
    <div className="panel-body">
      <button type="button" className="back back-button" onClick={onClose}>Close</button>
      <h1 className="panel-title">About</h1>
      <p className="panel-lead">
        For a site near the Moon’s south pole and a time you choose, this app says whether sunlight reaches the site and whether the Earth is in view,
        how much of each disc clears the terrain, and how long until it sets.
      </p>
      <h2 className="group-title">Where the numbers come from</h2>
      <p>
        Sun and Earth positions: NASA/JPL SPICE kernels (DE440), tabulated every {label.step_s / 3600} h from {formatUtc(label.t0_ms)} and interpolated in your browser.
        Skylines: computed ahead of time from LOLA elevation maps, with an uncertainty for every direction. Nothing is fetched from a server while you use the app.
      </p>
      <h2 className="group-title">What is approximate</h2>
      <p>
        Earth’s rotation: the data does not say which side of the Earth faces the Moon, so the Earth is drawn with a fixed side toward you. Its phase is exact.
        Terrain pictures and their shadows are for display; every stated answer comes from the full skyline. A custom point has no skyline, so it gets directions only.
      </p>
      <h2 className="group-title">Image credits</h2>
      {groups.map((group) => {
        const asset = assets.find((candidate) => candidate.path.startsWith(group.match));
        if (!asset) return null;
        return (
          <p key={group.title} data-testid="credit">
            <strong>{group.title}.</strong> {asset.credit}
            {asset.image_time ? ` Image time ${asset.image_time}.` : ""} Downloaded {asset.source.downloaded_utc.slice(0, 10)}.
          </p>
        );
      })}
      <p className="panel-lead">CGI Moon Kit (NASA’s Scientific Visualization Studio); LRO/LOLA maps from the Planetary Geodesy Data Archive (PGDA); Blue Marble: Next Generation (NASA Earth Observatory). Full list: assets/CREDITS.md.</p>
    </div>
  );
}
