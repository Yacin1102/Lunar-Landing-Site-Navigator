import { useEffect, useRef, useState } from "react";
import type { Direction } from "../engine/runtime-types";
import type { Site } from "../engine/types";

interface VectorLike {
  x: number;
  y: number;
  z: number;
  copy(value: VectorLike): VectorLike;
  multiplyScalar(value: number): VectorLike;
  set(x: number, y: number, z: number): VectorLike;
  normalize(): VectorLike;
  clone(): VectorLike;
}

interface ObjectLike {
  position: VectorLike;
  rotation: VectorLike;
  scale: VectorLike;
  aspect?: number;
  updateProjectionMatrix?(): void;
  add(...children: ObjectLike[]): void;
}

interface RendererLike {
  domElement: HTMLCanvasElement;
  setPixelRatio(value: number): void;
  setSize(width: number, height: number): void;
  render(scene: ObjectLike, camera: ObjectLike): void;
  dispose(): void;
}

interface ControlsLike {
  enableDamping: boolean;
  minDistance: number;
  maxDistance: number;
  target: VectorLike;
  update(): void;
  dispose(): void;
}

interface ThreeApi {
  WebGLRenderer: new (options: { antialias: boolean; alpha: boolean }) => RendererLike;
  Scene: new () => ObjectLike;
  PerspectiveCamera: new (fov: number, aspect: number, near: number, far: number) => ObjectLike;
  OrbitControls: new (camera: ObjectLike, canvas: HTMLCanvasElement) => ControlsLike;
  Vector3: new (x?: number, y?: number, z?: number) => VectorLike;
  SphereGeometry: new (radius: number, widthSegments: number, heightSegments: number) => object;
  MeshStandardMaterial: new (options: Record<string, unknown>) => object;
  MeshBasicMaterial: new (options: Record<string, unknown>) => object;
  Mesh: new (geometry: object, material: object) => ObjectLike;
  AmbientLight: new (color: number, intensity: number) => ObjectLike;
  DirectionalLight: new (color: number, intensity: number) => ObjectLike;
  PointLight: new (color: number, intensity: number, distance: number) => ObjectLike;
  CanvasTexture: new (canvas: HTMLCanvasElement) => object;
  TextureLoader: new () => { load(source: string, onLoad: (texture: object) => void): void };
  Sprite: new (material: object) => ObjectLike;
  SpriteMaterial: new (options: Record<string, unknown>) => object;
  BufferGeometry: new () => { setAttribute(name: string, value: object): void };
  BufferAttribute: new (array: Float32Array, itemSize: number) => object;
  PointsMaterial: new (options: Record<string, unknown>) => object;
  Points: new (geometry: object, material: object) => ObjectLike;
  Raycaster: new () => { setFromCamera(pointer: object, camera: ObjectLike): void; intersectObjects(objects: ObjectLike[]): Array<{ object: ObjectLike }> };
  Color: new (color: number) => object;
  AdditiveBlending: number;
}

interface SpaceSceneProps {
  site: Site;
  sites: Site[];
  sun: Direction;
  earth: Direction;
  onSelectSite: (siteId: string) => void;
}

/** Render the space-view experience from the supplied Moon viewer prototype. */
export function SpaceScene({ site, sites, sun, earth, onSelectSite }: SpaceSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Loading 3D space view…");

  useEffect(() => {
    let disposed = false;
    let renderer: RendererLike | undefined;
    let controls: ControlsLike | undefined;
    let animation = 0;

    loadThree()
      .then((three) => {
        if (disposed || !hostRef.current) return;
        const host = hostRef.current;
        const width = host.clientWidth;
        const height = host.clientHeight;
        renderer = new three.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height);
        host.replaceChildren(renderer.domElement);

        const scene = new three.Scene();
        const camera = new three.PerspectiveCamera(45, width / height, 0.1, 100);
        camera.position.copy(siteVector(three, site)).multiplyScalar(3.2);
        controls = new three.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.minDistance = 1.4;
        controls.maxDistance = 14;
        controls.target.set(0, 0, 0);

        const moonMaterial = new three.MeshStandardMaterial({
          map: createMoonTexture(three),
          roughness: 1,
        }) as { map?: object; needsUpdate?: boolean };
        new three.TextureLoader().load("https://threejs.org/examples/textures/planets/moon_1024.jpg", (texture) => {
          moonMaterial.map = texture;
          moonMaterial.needsUpdate = true;
        });
        const moon = new three.Mesh(new three.SphereGeometry(1, 128, 96), moonMaterial);
        scene.add(moon);
        scene.add(new three.AmbientLight(0xffffff, 0.08));
        const light = new three.DirectionalLight(0xffffff, 1.9);
        light.position.copy(directionVector(three, sun)).multiplyScalar(20);
        scene.add(light);

        const sunSprite = new three.Sprite(new three.SpriteMaterial({ color: 0xffc857, transparent: true, opacity: 0.92 }));
        sunSprite.scale.set(1.8, 1.8, 1);
        sunSprite.position.copy(directionVector(three, sun)).multiplyScalar(9);
        scene.add(sunSprite);

        const earthGroup = new three.Mesh(new three.SphereGeometry(0.22, 64, 48), new three.MeshStandardMaterial({ color: 0x4185d7, roughness: 0.85 }));
        earthGroup.position.copy(directionVector(three, earth)).multiplyScalar(6);
        scene.add(earthGroup);
        const atmosphere = new three.Mesh(new three.SphereGeometry(0.245, 48, 32), new three.MeshBasicMaterial({
          color: 0x4c8bff,
          transparent: true,
          opacity: 0.18,
          side: 1,
          blending: three.AdditiveBlending,
        }));
        atmosphere.position.copy(earthGroup.position);
        scene.add(atmosphere);
        scene.add(createStars(three));

        const markerMeshes: ObjectLike[] = [];
        for (const candidate of sites) {
          const marker = new three.Mesh(
            new three.SphereGeometry(candidate.id === site.id ? 0.045 : 0.028, 16, 12),
            new three.MeshBasicMaterial({ color: candidate.id === site.id ? 0xef4444 : 0xf59e0b }),
          );
          marker.position.copy(siteVector(three, candidate)).multiplyScalar(1.02);
          markerMeshes.push(marker);
          scene.add(marker);
        }

        const pointer = new three.Vector3();
        const raycaster = new three.Raycaster();
        let pointerDown: { x: number; y: number } | undefined;
        const onPointerDown = (event: PointerEvent) => { pointerDown = { x: event.clientX, y: event.clientY }; };
        const onPointerUp = (event: PointerEvent) => {
          if (!pointerDown || Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) return;
          const bounds = renderer?.domElement.getBoundingClientRect();
          if (!bounds) return;
          pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1, 0);
          raycaster.setFromCamera(pointer, camera);
          const hit = raycaster.intersectObjects(markerMeshes)[0];
          const index = hit ? markerMeshes.indexOf(hit.object) : -1;
          if (index >= 0) onSelectSite(sites[index].id);
          pointerDown = undefined;
        };
        renderer.domElement.addEventListener("pointerdown", onPointerDown);
        renderer.domElement.addEventListener("pointerup", onPointerUp);
        setStatus("Drag to rotate · scroll or pinch to zoom · click a site marker");

        const resize = () => {
          if (!renderer || !hostRef.current) return;
          const nextWidth = hostRef.current.clientWidth;
          const nextHeight = hostRef.current.clientHeight;
          renderer.setSize(nextWidth, nextHeight);
          camera.aspect = nextWidth / nextHeight;
          camera.updateProjectionMatrix?.();
        };
        window.addEventListener("resize", resize);
        const loop = () => {
          if (disposed || !renderer || !controls) return;
          animation = window.requestAnimationFrame(loop);
          controls.update();
          renderer.render(scene, camera);
        };
        loop();

        return () => {
          window.removeEventListener("resize", resize);
          renderer?.domElement.removeEventListener("pointerdown", onPointerDown);
          renderer?.domElement.removeEventListener("pointerup", onPointerUp);
        };
      })
      .catch(() => setStatus("3D view could not load. Check the network connection and reload."));

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animation);
      controls?.dispose();
      renderer?.dispose();
      hostRef.current?.replaceChildren();
    };
  }, [earth, onSelectSite, site, sites, sun]);

  return <div className="space-scene" ref={hostRef} role="img" aria-label={`3D lunar satellite view centered on ${site.name}`}>
    <div className="space-scene-status">{status}</div>
    <div className="space-scene-legend"><span><i className="legend-sun" /> Sun</span><span><i className="legend-earth" /> Earth</span><span><i className="legend-site" /> Sites</span></div>
  </div>;
}

/** Load the same Three.js and OrbitControls runtime used by the supplied prototype. */
async function loadThree(): Promise<ThreeApi> {
  const existing = (window as unknown as { THREE?: ThreeApi }).THREE;
  if (existing?.OrbitControls) return existing;
  await loadScript("https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js");
  await loadScript("https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js");
  const three = (window as unknown as { THREE?: ThreeApi }).THREE;
  if (!three) throw new Error("Three.js did not load.");
  return three;
}

/** Add one external script only once and wait until the browser has executed it. */
function loadScript(source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const current = document.querySelector<HTMLScriptElement>(`script[src="${source}"]`);
    if (current) {
      if ((window as unknown as { THREE?: ThreeApi }).THREE?.OrbitControls) resolve();
      else current.addEventListener("load", () => resolve(), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = source;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Unable to load ${source}`));
    document.head.appendChild(script);
  });
}

/** Convert a site's east-positive latitude/longitude into the Moon globe frame used by the prototype. */
function siteVector(three: ThreeApi, site: Site): VectorLike {
  const degrees = Math.PI / 180;
  return new three.Vector3(
    Math.cos(site.lat * degrees) * Math.cos(site.lon * degrees),
    Math.sin(site.lat * degrees),
    -Math.cos(site.lat * degrees) * Math.sin(site.lon * degrees),
  );
}

/** Convert a local azimuth/elevation direction into a visible 3D mission-scene vector. */
function directionVector(three: ThreeApi, direction: Direction): VectorLike {
  const degrees = Math.PI / 180;
  const azimuth = direction.az_deg * degrees;
  const elevation = direction.el_deg * degrees;
  return new three.Vector3(
    Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
  ).normalize();
}

/** Create a procedural lunar texture so the globe has visible craters without opening NASA files. */
function createMoonTexture(three: ThreeApi): object {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) return new three.CanvasTexture(canvas);
  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#bab2a2");
  gradient.addColorStop(0.5, "#746f69");
  gradient.addColorStop(1, "#2c2d32");
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < 180; index += 1) {
    const x = (index * 97) % canvas.width;
    const y = (index * 61) % canvas.height;
    const radius = 1 + (index % 8) * 1.6;
    context.fillStyle = "rgba(20,20,24,.24)";
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }
  return new three.CanvasTexture(canvas);
}

/** Create a quiet star field around the Moon, matching the prototype's space backdrop. */
function createStars(three: ThreeApi): ObjectLike {
  const positions = new Float32Array(900);
  for (let index = 0; index < 300; index += 1) {
    const angle = index * 2.4;
    const height = ((index * 37) % 200) / 100 - 1;
    const scale = Math.sqrt(1 - height * height) * 35;
    positions[index * 3] = Math.cos(angle) * scale;
    positions[index * 3 + 1] = height * 35;
    positions[index * 3 + 2] = Math.sin(angle) * scale;
  }
  const geometry = new three.BufferGeometry();
  geometry.setAttribute("position", new three.BufferAttribute(positions, 3));
  return new three.Points(geometry, new three.PointsMaterial({ color: 0xffffff, size: 0.08, sizeAttenuation: false }));
}
