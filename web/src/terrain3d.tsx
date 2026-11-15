import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { Direction, ShadeGrid, TerrainPatch } from "../engine/runtime-types";
import type { Skyline } from "../engine/types";
import { visibleDiscFraction } from "../engine/visibility";

/** Convert an azimuth/elevation direction into the east/north/up Three.js frame. */
export function directionToThree(direction: Pick<Direction, "az_deg" | "el_deg">): THREE.Vector3 {
  const azimuth = THREE.MathUtils.degToRad(direction.az_deg);
  const elevation = THREE.MathUtils.degToRad(direction.el_deg);
  const horizontal = Math.cos(elevation);
  return new THREE.Vector3(
    horizontal * Math.sin(azimuth),
    horizontal * Math.cos(azimuth),
    Math.sin(elevation),
  ).normalize();
}

/** Convert a row and column into east/north metres using the terrain contract. */
export function gridToEastNorth(row: number, column: number, n: number, spacingM: number): { eastM: number; northM: number } {
  return {
    eastM: (column - (n - 1) / 2) * spacingM,
    northM: ((n - 1) / 2 - row) * spacingM,
  };
}

/** Compute one shade cell's Sun-disc fraction and Lambertian brightness. */
export function shadeBrightness(
  shade: ShadeGrid,
  cellIndex: number,
  direction: Direction,
  body: "sun" | "earth",
  skylineFallback: Skyline,
): number {
  const n = shade.label.n;
  const row = Math.floor(cellIndex / n);
  const column = cellIndex % n;
  const azimuths = Array.from({ length: shade.label.n_az }, (_, index) => {
    const offset = index * shade.label.az_step_deg;
    return shade.skyline[(cellIndex * shade.label.n_az) + index] * shade.label.skyline_scale + offset;
  });
  const skyline = {
    ...skylineFallback,
    az_step_deg: shade.label.az_step_deg,
    skyline_deg: azimuths,
    skyline_err_deg: azimuths.map(() => 0),
  };
  const fraction = visibleDiscFraction(direction, body, skyline, 32);
  const normalOffset = cellIndex * 3;
  const normal = new THREE.Vector3(shade.normal[normalOffset], shade.normal[normalOffset + 1], shade.normal[normalOffset + 2]);
  const light = directionToThree(direction);
  const incidence = Math.max(0, normal.normalize().dot(light));
  void row;
  void column;
  return Math.max(0, Math.min(1, fraction * incidence));
}

/** Build a display-only terrain mesh from the contract's north-to-south grid. */
export function buildTerrainGeometry(patch: TerrainPatch, exaggeration: number): THREE.BufferGeometry {
  const { n, spacing_m: spacing } = patch.label;
  const positions = new Float32Array(n * n * 3);
  for (let row = 0; row < n; row += 1) {
    for (let column = 0; column < n; column += 1) {
      const index = row * n + column;
      const point = gridToEastNorth(row, column, n, spacing);
      positions[index * 3] = point.eastM;
      positions[index * 3 + 1] = point.northM;
      positions[index * 3 + 2] = patch.values[index] * exaggeration;
    }
  }
  const indices: number[] = [];
  for (let row = 0; row < n - 1; row += 1) {
    for (let column = 0; column < n - 1; column += 1) {
      const topLeft = row * n + column;
      indices.push(topLeft, topLeft + 1, topLeft + n, topLeft + 1, topLeft + n + 1, topLeft + n);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Render the prepared terrain patch with orbit and stand-at-site camera modes. */
export function Terrain3DView({
  patch,
  shade,
  skyline,
  sun,
  earth,
  sunFraction,
}: {
  patch: TerrainPatch;
  shade?: ShadeGrid;
  skyline?: Skyline;
  sun: Direction;
  earth: Direction;
  sunFraction: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [exaggeration, setExaggeration] = useState(1.5);
  const [standAtSite, setStandAtSite] = useState(false);
  const cameraRef = useRef<THREE.PerspectiveCamera | undefined>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#050607");
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
    cameraRef.current = camera;
    const controlsTarget = new THREE.Vector3(0, 0, 0);
    const resize = () => {
      const width = canvas.clientWidth || 640;
      const height = canvas.clientHeight || 420;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resetCamera = () => {
      camera.position.set(0, -patch.label.size_m * 0.8, patch.label.size_m * 0.7);
      camera.lookAt(controlsTarget);
    };
    resetCamera();
    resize();
    const geometry = buildTerrainGeometry(patch, exaggeration);
    const material = new THREE.MeshStandardMaterial({ color: "#777b80", roughness: 1 });
    const terrain = new THREE.Mesh(geometry, material);
    scene.add(terrain);
    scene.add(new THREE.AmbientLight("#6b6b6b", 0.35));
    const sunLight = new THREE.DirectionalLight("#f4c95d", Math.max(0.1, sunFraction));
    sunLight.position.copy(directionToThree(sun)).multiplyScalar(patch.label.size_m);
    scene.add(sunLight);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(Math.max(2, patch.label.spacing_m * 0.12), 12, 8), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
    marker.position.z = Math.max(2, patch.label.spacing_m * 0.12);
    scene.add(marker);
    const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(Math.max(4, patch.label.spacing_m * 0.2), 12, 8), new THREE.MeshBasicMaterial({ color: "#f4c95d" }));
    sunDisc.position.copy(directionToThree(sun)).multiplyScalar(patch.label.size_m * 0.45);
    scene.add(sunDisc);
    const earthDisc = new THREE.Mesh(new THREE.SphereGeometry(Math.max(4, patch.label.spacing_m * 0.2), 12, 8), new THREE.MeshBasicMaterial({ color: "#5a9bd8" }));
    earthDisc.position.copy(directionToThree(earth)).multiplyScalar(patch.label.size_m * 0.45);
    earthDisc.visible = earth.el_deg > 0;
    scene.add(earthDisc);
    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      if (standAtSite) {
        camera.position.set(0, 0, Math.max(2, patch.label.spacing_m * 0.4));
        camera.lookAt(directionToThree(sun).multiplyScalar(patch.label.size_m));
      }
      renderer.render(scene, camera);
    };
    animate();
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, [earth, exaggeration, patch, standAtSite, sun, sunFraction]);

  if (!shade || !skyline) {
    return <section className="view-panel unavailable"><h1>3D view</h1><p>3D view is available for featured sites.</p></section>;
  }
  return <section className="view-panel terrain-panel">
    <div className="view-title"><div><p className="eyebrow">Terrain and shade</p><h1>3D view</h1></div><span className="view-caption">Site light: {Math.round(sunFraction * 100)}%</span></div>
    <canvas ref={canvasRef} className="terrain-canvas" aria-label="Interactive three-dimensional terrain view" />
    <div className="terrain-controls">
      <label>Vertical exaggeration <input type="range" min="1" max="3" step="0.1" value={exaggeration} onChange={(event) => setExaggeration(Number(event.target.value))} /></label>
      <button type="button" onClick={() => setStandAtSite((current) => !current)}>{standAtSite ? "Orbit mode" : "Stand at the site"}</button>
      <button type="button" onClick={() => { cameraRef.current?.position.set(0, -patch.label.size_m * 0.8, patch.label.size_m * 0.7); cameraRef.current?.lookAt(0, 0, 0); }}>Reset view</button>
    </div>
  </section>;
}
