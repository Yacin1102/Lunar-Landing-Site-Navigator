import { useEffect, useRef, useState } from "react";
import type { DataBundle } from "../../engine/runtime-types";
import { polarProject, polarUnproject } from "../lib/geometry";
import { formatLatLon } from "../lib/sites";

/** The hillshade's georeference, as written by fetch-assets from the GeoTIFF's own tags. */
interface Sidecar {
  width: number;
  height: number;
  sphere_radius_m: number;
  metres_per_pixel: number;
  x_min_m: number;
  y_max_m: number;
}

interface View {
  /** Screen pixels per map metre. */
  scale: number;
  /** Map point (metres) shown at the centre of the stage. */
  x: number;
  y: number;
}

/** A round length for the scale bar: the largest of 1, 2, 5 x 10^k metres not above `maxM`. */
function roundLength(maxM: number): number {
  const base = 10 ** Math.floor(Math.log10(maxM));
  return [5, 2, 1].map((step) => step * base).find((length) => length <= maxM) ?? base;
}

/**
 * Scene 2, the polar map: the LOLA hillshade in its own south polar stereographic projection.
 *
 * How it works: the picture is positioned with the sidecar's corner coordinates and pixel size,
 * so a map point (metres) and a screen point are related by one scale and one offset. Site
 * markers use the same projection formula as the picture. The readout under the cursor is the
 * inverse projection. The scale bar is exact at the pole; a stereographic map stretches
 * distances by up to 0.8 % at 80 degrees south, which the label states.
 */
export function PolarMap({ bundle, onOpen }: { bundle: DataBundle; onOpen: (siteId: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [sidecar, setSidecar] = useState<Sidecar>();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>();
  const [cursor, setCursor] = useState<{ lat: number; lon: number }>();
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    fetch("/assets/hillshade/south_pole_hillshade.json").then((response) => response.json()).then(setSidecar, () => undefined);
  }, []);

  useEffect(() => {
    const host = hostRef.current!;
    const observer = new ResizeObserver(() => setSize({ width: host.clientWidth, height: host.clientHeight }));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const extentM = sidecar ? sidecar.width * sidecar.metres_per_pixel : 0;
  const fitScale = sidecar && size.width > 0 ? Math.min(size.width, size.height) / extentM : 0;
  // Open on the polar cap that holds the curated sites, not on the whole 80 S disc.
  useEffect(() => {
    if (!sidecar || fitScale === 0 || view) return;
    const farthest = Math.max(...bundle.sites.map((site) => Math.hypot(...Object.values(polarProject(site.lat, site.lon, sidecar.sphere_radius_m)))));
    setView({ scale: Math.max(fitScale, Math.min(size.width, size.height) / (2.5 * farthest)), x: 0, y: 0 });
  }, [sidecar, fitScale, view, bundle, size]);

  if (!sidecar || !view) return <div className="scene" ref={hostRef} />;

  const toScreen = (x: number, y: number) => ({ left: size.width / 2 + (x - view.x) * view.scale, top: size.height / 2 - (y - view.y) * view.scale });
  const toMap = (left: number, top: number) => ({ x: view.x + (left - size.width / 2) / view.scale, y: view.y - (top - size.height / 2) / view.scale });
  const corner = toScreen(sidecar.x_min_m, sidecar.y_max_m);
  const zoom = (factor: number) => setView({ ...view, scale: Math.min(Math.max(view.scale * factor, fitScale), 1 / 20) });
  const barM = roundLength(140 / view.scale);
  const local = (event: React.PointerEvent | React.WheelEvent) => {
    const box = hostRef.current!.getBoundingClientRect();
    return { left: event.clientX - box.left, top: event.clientY - box.top };
  };

  return (
    <div
      className="scene scene-map"
      ref={hostRef}
      data-ready="true"
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerLeave={() => {
        drag.current = null;
        setCursor(undefined);
      }}
      onPointerMove={(event) => {
        const point = local(event);
        const map = toMap(point.left, point.top);
        const inside = Math.abs(map.x) <= extentM / 2 && Math.abs(map.y) <= extentM / 2;
        setCursor(inside ? polarUnproject(map.x, map.y, sidecar.sphere_radius_m) : undefined);
        if (drag.current) {
          setView({ ...view, x: view.x - (event.clientX - drag.current.x) / view.scale, y: view.y + (event.clientY - drag.current.y) / view.scale });
          drag.current = { x: event.clientX, y: event.clientY };
        }
      }}
      onWheel={(event) => zoom(event.deltaY < 0 ? 1.25 : 0.8)}
    >
      <img
        className="map-image"
        src="/assets/hillshade/south_pole_hillshade.png"
        alt="Shaded relief map of the lunar south pole, to 80 degrees south"
        draggable={false}
        style={{ left: corner.left, top: corner.top, width: extentM * view.scale, height: extentM * view.scale }}
      />
      <div className="markers">
        {bundle.sites.map((site) => {
          const map = polarProject(site.lat, site.lon, sidecar.sphere_radius_m);
          const screen = toScreen(map.x, map.y);
          return (
            <button key={site.id} type="button" className="marker" style={{ transform: `translate(${screen.left}px, ${screen.top}px)` }} onClick={() => onOpen(site.id)}>
              <span className="marker-dot" />
              <span className="marker-name">{site.name}</span>
            </button>
          );
        })}
      </div>
      <div className="map-zoom">
        <button type="button" aria-label="Zoom in" onClick={() => zoom(1.5)}>+</button>
        <button type="button" aria-label="Zoom out" onClick={() => zoom(1 / 1.5)}>−</button>
      </div>
      <div className="map-legend">
        <div className="scale-bar" style={{ width: barM * view.scale }} />
        <span data-testid="scale-label">{barM >= 1000 ? `${barM / 1000} km` : `${barM} m`} at the pole</span>
        <span className="map-cursor" data-testid="cursor-readout">{cursor ? formatLatLon(cursor.lat, cursor.lon, 3) : "Move over the map to read a position"}</span>
      </div>
      <p className="scene-note">Polar stereographic, longitude 0° (toward Earth) up, 90° E right. Distances are stretched by up to 0.8 % at 80° S.</p>
    </div>
  );
}
