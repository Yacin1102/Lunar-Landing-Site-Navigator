import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Direction, ShadeGrid, TerrainPatch } from "../../engine/runtime-types";
import { azElToEnu } from "../lib/geometry";
import { cellClear, sampleGrid } from "../lib/shade";

/** Brightness given to ground that receives no sunlight, so its shape can still be seen. */
const SHADOW_LEVEL = 0.07;

/**
 * Scene 3, terrain: the site's real elevation patch in 3D, lit for the selected time.
 *
 * How it works: one vertex per sample of `terrain/{id}.bin`, placed at (east, height, north)
 * in metres exactly as the handoff defines them, with no vertical exaggeration. The mesh has no
 * three.js lights. Each vertex's brightness is the cosine between the Sun's direction and the
 * surface normal of the patch itself (from neighbouring heights), times the share of the Sun's
 * disc above the local skyline, which comes from the shade grid and is read between its cells
 * bilinearly. Because the polar Sun is always low, raw brightness would be nearly
 * black, so the picture is exposed to its brightest ground (stated on screen), and the whole
 * scene is then dimmed by the share of the Sun's disc visible from the site (`sunFraction`).
 * Sizes come from the labels, never from constants.
 */
export function Terrain({ terrain, shade, sun, sunFraction }: { terrain: TerrainPatch; shade?: ShadeGrid; sun: Direction; sunFraction: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const normalsRef = useRef<Float32Array | null>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const { n, spacing_m: spacing, size_m: size } = terrain.label;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, size / 500, size * 20);
    camera.position.set(size * 1.0, size * 0.95, size * 1.45);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    controls.minDistance = size * 0.1;
    controls.maxDistance = size * 4;

    // three.js axes: x = east, y = up, z = south (so north is -z). Rows run north to south.
    const positions = new Float32Array(n * n * 3);
    const half = (n - 1) / 2;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const k = (i * n + j) * 3;
        positions[k] = (j - half) * spacing;
        positions[k + 1] = terrain.values[i * n + j];
        positions[k + 2] = (i - half) * spacing;
      }
    }
    // Surface normals as (east, north, up), from central differences of the heights.
    const normals = new Float32Array(n * n * 3);
    const height = (i: number, j: number) => terrain.values[Math.min(n - 1, Math.max(0, i)) * n + Math.min(n - 1, Math.max(0, j))];
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const east = -(height(i, j + 1) - height(i, j - 1)) / ((Math.min(n - 1, j + 1) - Math.max(0, j - 1)) * spacing);
        const north = -(height(i - 1, j) - height(i + 1, j)) / ((Math.min(n - 1, i + 1) - Math.max(0, i - 1)) * spacing);
        const length = Math.hypot(east, north, 1);
        normals.set([east / length, north / length, 1 / length], (i * n + j) * 3);
      }
    }
    normalsRef.current = normals;
    const index = new Uint32Array((n - 1) * (n - 1) * 6);
    let at = 0;
    for (let i = 0; i < n - 1; i += 1) {
      for (let j = 0; j < n - 1; j += 1) {
        const a = i * n + j;
        index.set([a, a + n, a + 1, a + 1, a + n, a + n + 1], at);
        at += 6;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    meshRef.current = mesh;

    // The site itself: a thin post at the patch centre (height 0 by contract), 2 % of the patch tall.
    const post = new THREE.Mesh(new THREE.CylinderGeometry(size / 600, size / 600, size / 50), new THREE.MeshBasicMaterial({ color: 0xe9c46a }));
    post.position.set(0, size / 100, 0);
    scene.add(post);
    // North arrow on the northern edge, pointing along the meridian toward the north pole.
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, terrain.values[half] + size / 40, -size / 2), size / 8, 0xe9c46a, size / 30, size / 60);
    scene.add(arrow);

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
    };
    draw();
    return () => {
      cancelAnimationFrame(frame);
      controls.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [terrain]);

  // Recolour only when the time (Sun direction) changes, in one pass over the vertices.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const { n, spacing_m: spacing } = terrain.label;
    const colours = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const array = colours.array as Float32Array;
    const normals = normalsRef.current;
    if (!normals) return;
    const clear = shade ? cellClear(shade, sun) : undefined;
    const [east, north, up] = azElToEnu(sun.az_deg, sun.el_deg);
    const half = (n - 1) / 2;
    const light = new Float32Array(n * n);
    let brightest = 0;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const v = i * n + j;
        let share = 1;
        if (clear && shade) {
          // The same east/north position expressed in shade-grid cells (both grids are centred on the site).
          const cells = shade.label.n;
          share = sampleGrid(clear, cells, (cells - 1) / 2 + ((i - half) * spacing) / shade.label.spacing_m, (cells - 1) / 2 + ((j - half) * spacing) / shade.label.spacing_m);
        }
        light[v] = share * Math.max(0, normals[v * 3] * east + normals[v * 3 + 1] * north + normals[v * 3 + 2] * up);
        if (light[v] > brightest) brightest = light[v];
      }
    }
    const dim = 0.25 + 0.75 * sunFraction;
    for (let v = 0; v < n * n; v += 1) {
      const level = brightest > 0 ? SHADOW_LEVEL + (1 - SHADOW_LEVEL) * Math.sqrt(light[v] / brightest) * dim : SHADOW_LEVEL;
      // Grey with a slight warm tint, like sunlit regolith.
      array.set([level * 0.82, level * 0.8, level * 0.76], v * 3);
    }
    colours.needsUpdate = true;
  }, [terrain, shade, sun, sunFraction]);

  const { n, spacing_m: spacing, size_m: size, dem, resolution_m: resolution } = terrain.label;
  return (
    <div className="scene" ref={hostRef} data-ready="true">
      <p className="scene-note">
        {size / 1000} km × {size / 1000} km, {n} × {n} samples {spacing} m apart, from {dem.join(", ")} ({resolution} m map). No vertical exaggeration.
        The arrow points north; the post marks the site. Brightness is exposed to the brightest ground in view (square-root tone curve)
        {shade ? `; shadows come from a ${shade.label.n} × ${shade.label.n} grid ${shade.label.spacing_m} m apart and are for display only.` : "; no shade grid exists for this site."}
      </p>
    </div>
  );
}
