import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { decode } from "fast-png";
import { interpolateBody, sitePosition } from "../../engine/astro";
import { normalize } from "../../engine/math";
import type { DataBundle } from "../../engine/runtime-types";
import { MOON_RADIUS_M } from "../../engine/types";
import { meToThree } from "../lib/geometry";

/** Light added to the true sunlight so the night side and the polar shadows stay readable. */
const FILL_LIGHT = 0.5;

interface ElevationAsset {
  path: string;
  encoding?: { metres_per_count: number; offset_m: number };
}

/**
 * Scene 1, the globe: the Moon as a sphere, opening on the south pole.
 *
 * Role: an overview to find and open a site.
 *
 * How it works: a three.js sphere of radius 1 (= 1737.4 km) carries the LROC colour map. The
 * LOLA elevation map is decoded here from its 16-bit PNG (a browser would flatten it to 8 bits)
 * into metres with the formula recorded in assets.json, and moves each vertex outward by its
 * true height: relief is at true scale, not exaggerated. The directional light comes from the
 * Sun's real direction at the selected time (timetable, MOON_ME); a labelled fill light is
 * added. Site markers are HTML buttons placed by projecting each site's MOON_ME position; a
 * marker on the far side of the globe is hidden.
 */
export function Globe({ bundle, timeMs, onOpen }: { bundle: DataBundle; timeMs: number; onOpen: (siteId: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const markerRefs = useRef(new Map<string, HTMLButtonElement>());
  const sunRef = useRef<THREE.DirectionalLight | null>(null);
  const [ready, setReady] = useState(false);
  const [relief, setRelief] = useState(false);

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 50);
    // Start above the south pole with longitude 0 (the Earth-facing side) toward the top.
    camera.up.set(...meToThree({ x: 1, y: 0, z: 0 }));
    camera.position.set(...meToThree({ x: 0, y: 0, z: -1.75 }));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 1.08;
    controls.maxDistance = 8;
    controls.rotateSpeed = 0.5;

    const loader = new THREE.TextureLoader();
    const colour = loader.load("/assets/moon/lroc_color_4096.jpg", () => setReady(true));
    colour.colorSpace = THREE.SRGBColorSpace;
    colour.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const material = new THREE.MeshStandardMaterial({ map: colour, roughness: 1, metalness: 0 });
    const geometry = new THREE.SphereGeometry(1, 720, 360);
    scene.add(new THREE.Mesh(geometry, material));
    scene.add(new THREE.AmbientLight(0xffffff, FILL_LIGHT));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    scene.add(sun);
    sunRef.current = sun;

    // Relief: decode the 16-bit elevation PNG to metres and displace by height / radius.
    let cancelled = false;
    let heights: THREE.DataTexture | undefined;
    (async () => {
      const manifest = (await (await fetch("/assets/assets.json")).json()) as { assets: ElevationAsset[] };
      const asset = manifest.assets.find((candidate) => candidate.encoding);
      if (!asset?.encoding) return;
      const png = decode(await (await fetch(`/assets/${asset.path}`)).arrayBuffer());
      if (cancelled || png.depth !== 16 || png.channels !== 1) return;
      const metres = new Float32Array(png.width * png.height);
      for (let row = 0; row < png.height; row += 1) {
        // A data texture's first row is the bottom of the picture; the map's first row is north.
        const target = (png.height - 1 - row) * png.width;
        for (let column = 0; column < png.width; column += 1) {
          metres[target + column] = png.data[row * png.width + column] * asset.encoding.metres_per_count + asset.encoding.offset_m;
        }
      }
      heights = new THREE.DataTexture(metres, png.width, png.height, THREE.RedFormat, THREE.FloatType);
      heights.wrapS = THREE.RepeatWrapping;
      heights.minFilter = THREE.NearestFilter;
      heights.magFilter = THREE.NearestFilter;
      heights.needsUpdate = true;
      material.displacementMap = heights;
      material.displacementScale = 1 / MOON_RADIUS_M;
      material.needsUpdate = true;
      setRelief(true);
    })().catch(() => undefined);

    const sitesUnit = bundle.sites.map((site) => ({ id: site.id, position: new THREE.Vector3(...meToThree(normalize(sitePosition(site.lat, site.lon, 0)))) }));
    const projected = new THREE.Vector3();
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const { clientWidth: width, clientHeight: height } = host;
      if (renderer.domElement.width !== Math.floor(width * renderer.getPixelRatio()) || renderer.domElement.height !== Math.floor(height * renderer.getPixelRatio())) {
        renderer.setSize(width, height, false);
        camera.aspect = width / Math.max(1, height);
        camera.updateProjectionMatrix();
      }
      controls.update();
      renderer.render(scene, camera);
      for (const site of sitesUnit) {
        const marker = markerRefs.current.get(site.id);
        if (!marker) continue;
        // A point on a unit sphere faces the camera when its dot product with the camera position exceeds 1.
        const visible = site.position.dot(camera.position) > 1;
        projected.copy(site.position).project(camera);
        marker.style.display = visible ? "" : "none";
        marker.style.transform = `translate(${((projected.x + 1) / 2) * width}px, ${((1 - projected.y) / 2) * height}px)`;
      }
    };
    draw();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      controls.dispose();
      geometry.dispose();
      material.dispose();
      colour.dispose();
      heights?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [bundle]);

  // The Sun's true direction at the selected time, from the Moon's centre.
  useEffect(() => {
    const { label, values } = bundle.ephemeris;
    sunRef.current?.position.set(...meToThree(normalize(interpolateBody(values, label, timeMs, 0))));
  }, [bundle, timeMs]);

  return (
    <div className="scene" ref={hostRef} data-ready={ready} data-relief={relief}>
      <div className="markers">
        {bundle.sites.map((site) => (
          <button
            key={site.id}
            type="button"
            className="marker"
            ref={(element) => {
              if (element) markerRefs.current.set(site.id, element);
              else markerRefs.current.delete(site.id);
            }}
            onClick={() => onOpen(site.id)}
          >
            <span className="marker-dot" />
            <span className="marker-name">{site.name}</span>
          </button>
        ))}
      </div>
      <p className="scene-note">
        Sunlight from the Sun’s true direction at the selected time, plus a fill light so shadowed ground stays visible.
        {relief ? " Relief at true scale." : " Loading relief…"} Point at a marker for its name. Drag to turn, scroll to zoom.
      </p>
    </div>
  );
}
