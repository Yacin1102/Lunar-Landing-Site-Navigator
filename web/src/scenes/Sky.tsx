import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { directionsAt, discRadiusDeg, interpolateBody, localBasis, sitePosition } from "../../engine/astro";
import { dot, normalize, subtract } from "../../engine/math";
import type { DataBundle, Vector3 } from "../../engine/runtime-types";
import type { Skyline } from "../../engine/types";
import { classifyVisibility } from "../../engine/visibility";
import { azDelta, earthMonthFile, earthPhaseAngleDeg, litFraction, smoothHorizonDeg } from "../lib/geometry";

/** How much larger the discs are drawn when "Magnify" is on. Positions never change. */
export const MAGNIFY = 10;
/** Radius, in screen pixels, at which a disc is drawn in probe mode (used by the browser tests). */
const PROBE_RADIUS_PX = 150;
/** The HMI picture is mid-grey at disc centre; this factor shows it at full brightness. */
const SUN_GAIN = 2.4;
const EARTH_PIXELS = 512;

interface View {
  az: number;
  el: number;
  /** Screen pixels per degree, the same along azimuth and elevation. */
  scale: number;
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** A tick spacing, in degrees, that puts ticks at least about 70 pixels apart. */
function tickStep(scale: number): number {
  return [0.1, 0.5, 1, 5, 10, 30, 90].find((step) => step * scale >= 70) ?? 90;
}

const COMPASS: Record<number, string> = { 0: "N", 90: "E", 180: "S", 270: "W" };

/**
 * Scene 3, sky view: the sky as seen from the eye, with the terrain skyline in front of it.
 *
 * How it works: a flat canvas in azimuth (across) and elevation (up), the same number of pixels
 * per degree both ways. Drawing order is what makes the picture honest: first the Sun and the
 * Earth at their true azimuth and elevation, then the terrain as an opaque shape filled from
 * the skyline down. The terrain therefore hides exactly the part of a disc that is below the
 * skyline; a half-set Sun shows half a disc. The skyline is drawn as the step function it is
 * (one flat piece per wedge), never smoothed.
 *
 * Sizes: each disc's angular radius is `asin(radius / distance)` from the engine, recomputed
 * from the interpolated distance on every draw. Near the horizon a disc of radius r spans
 * r / cos(elevation) in azimuth, which is how it is drawn.
 *
 * The Sun is the SDO/HMI picture. The Earth is a small three.js sphere with the month's Blue
 * Marble texture, lit by one directional light along the real Earth-to-Sun direction expressed
 * in the observer's view, so its phase is right by construction. Which side of the Earth faces
 * the Moon is not known to the app (docs/ENGINE_REQUESTS.md), so the texture's orientation is
 * fixed and a note says so.
 *
 * Without a skyline (a custom point) no terrain is drawn and nothing is hidden; a dashed line
 * marks the smooth-sphere horizon and is labelled as such.
 */
export function Sky({
  bundle, lat, lon, elevM, mastM, skyline, timeMs, probe,
}: {
  bundle: DataBundle; lat: number; lon: number; elevM: number; mastM: number; skyline?: Skyline; timeMs: number; probe?: "sun" | "earth";
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>();
  const [magnify, setMagnify] = useState(false);
  const [loaded, setLoaded] = useState(0);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const sunImage = useRef<HTMLImageElement | null>(null);
  const earth = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.OrthographicCamera; light: THREE.DirectionalLight; material: THREE.MeshLambertMaterial; file?: string } | null>(null);

  const { label, values } = bundle.ephemeris;
  const directions = useMemo(() => directionsAt(values, label, timeMs, lat, lon, elevM, mastM), [values, label, timeMs, lat, lon, elevM, mastM]);
  const factor = magnify ? MAGNIFY : 1;

  // What the Earth looks like from here: phase, and the Sun's direction in the observer's view.
  const earthView = useMemo(() => {
    const sunVector = interpolateBody(values, label, timeMs, 0);
    const earthVector = interpolateBody(values, label, timeMs, 3);
    const eye = sitePosition(lat, lon, elevM + mastM);
    const forward = normalize(subtract(earthVector, eye));
    const toSun = normalize(subtract(sunVector, earthVector));
    const right = normalize(cross(forward, localBasis(lat, lon).up));
    const up = cross(right, forward);
    return {
      lit: litFraction(earthPhaseAngleDeg(sunVector, earthVector, eye)),
      // Camera axes: x right, y up, z toward the observer.
      light: [dot(toSun, right), dot(toSun, up), -dot(toSun, forward)] as [number, number, number],
    };
  }, [values, label, timeMs, lat, lon, elevM, mastM]);

  useEffect(() => {
    const host = hostRef.current!;
    const observer = new ResizeObserver(() => setSize({ width: host.clientWidth, height: host.clientHeight }));
    observer.observe(host);
    const image = new Image();
    image.onload = () => {
      sunImage.current = image;
      setLoaded((count) => count + 1);
    };
    image.src = "/assets/sun/sun_hmi_2048.png";

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(EARTH_PIXELS, EARTH_PIXELS, false);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.set(0, 0, 5);
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), material);
    globe.rotation.y = -Math.PI / 2; // texture longitude 0 toward the viewer: a fixed, approximate orientation
    scene.add(globe);
    // A Lambert surface returns albedo x intensity x cos / pi, so pi gives full albedo at normal incidence.
    const light = new THREE.DirectionalLight(0xffffff, Math.PI);
    scene.add(light);
    earth.current = { renderer, scene, camera, light, material };
    return () => {
      observer.disconnect();
      globe.geometry.dispose();
      material.map?.dispose();
      material.dispose();
      renderer.dispose();
      earth.current = null;
    };
  }, []);

  // The Earth's texture follows the month of the selected UTC date. Probe mode uses plain white.
  const monthFile = probe === "earth" ? undefined : earthMonthFile(timeMs);
  useEffect(() => {
    const target = earth.current;
    if (!target || target.file === monthFile || !monthFile) return;
    target.file = monthFile;
    new THREE.TextureLoader().load(`/assets/${monthFile}`, (texture) => {
      if (earth.current !== target || target.file !== monthFile) return texture.dispose();
      texture.colorSpace = THREE.SRGBColorSpace;
      target.material.map?.dispose();
      target.material.map = texture;
      target.material.needsUpdate = true;
      setLoaded((count) => count + 1);
    });
  }, [monthFile]);

  const body = (name: "sun" | "earth") => directions[name];
  const defaultView = (name: "sun" | "earth", fieldDeg: number): View => ({ az: body(name).az_deg, el: body(name).el_deg, scale: size.width / fieldDeg });
  useEffect(() => {
    if (!view && size.width > 0) setView(defaultView("sun", 12));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width]);

  const shown: View | undefined = probe
    ? { az: body(probe).az_deg, el: body(probe).el_deg, scale: PROBE_RADIUS_PX / (discRadiusDeg(probe, body(probe).distance_km) * factor) }
    : view;
  const sunVisibility = useMemo(() => (skyline ? classifyVisibility(directions.sun, "sun", skyline) : undefined), [directions, skyline]);
  const earthVisibility = useMemo(() => (skyline ? classifyVisibility(directions.earth, "earth", skyline) : undefined), [directions, skyline]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !shown || size.width === 0) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const { width, height } = size;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    const s = shown.scale;
    const xOf = (az: number) => width / 2 + azDelta(az, shown.az) * s;
    const yOf = (el: number) => height / 2 - (el - shown.el) * s;
    const ellipse = (name: "sun" | "earth") => {
      const d = body(name);
      const ry = discRadiusDeg(name, d.distance_km) * s * factor;
      return { x: xOf(d.az_deg), y: yOf(d.el_deg), rx: ry / Math.cos((d.el_deg * Math.PI) / 180), ry };
    };
    const sun = ellipse("sun");
    const earthDisc = ellipse("earth");

    // 1. The bodies, behind everything else.
    if (!probe) {
      const glow = ctx.createRadialGradient(sun.x, sun.y, sun.ry, sun.x, sun.y, sun.ry * 5);
      glow.addColorStop(0, "rgba(255, 246, 225, 0.20)");
      glow.addColorStop(1, "rgba(255, 246, 225, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(sun.x - sun.ry * 5, sun.y - sun.ry * 5, sun.ry * 10, sun.ry * 10);
    }
    if (sunImage.current && probe !== "earth") {
      ctx.filter = `brightness(${SUN_GAIN})`;
      ctx.drawImage(sunImage.current, sun.x - sun.rx, sun.y - sun.ry, sun.rx * 2, sun.ry * 2);
      ctx.filter = "none";
    }
    if (earth.current && probe !== "sun") {
      earth.current.light.position.set(...earthView.light);
      earth.current.renderer.render(earth.current.scene, earth.current.camera);
      ctx.drawImage(earth.current.renderer.domElement, earthDisc.x - earthDisc.rx, earthDisc.y - earthDisc.ry, earthDisc.rx * 2, earthDisc.ry * 2);
    }

    // 2. The terrain, in front: an opaque shape from the skyline down, one flat piece per wedge.
    const halfField = width / (2 * s);
    if (skyline) {
      const step = skyline.az_step_deg;
      const n = skyline.skyline_deg.length;
      const first = Math.floor((shown.az - Math.min(180, halfField)) / step);
      const last = Math.ceil((shown.az + Math.min(180, halfField)) / step);
      const edge = (k: number) => width / 2 + ((k - 0.5) * step - shown.az) * s;
      const level = (k: number, shift: number) => {
        const i = ((k % n) + n) % n;
        return yOf(skyline.skyline_deg[i] + shift * skyline.skyline_err_deg[i]);
      };
      const trace = (shift: number) => {
        ctx.beginPath();
        ctx.moveTo(edge(first), level(first, shift));
        for (let k = first; k <= last; k += 1) {
          ctx.lineTo(edge(k), level(k, shift));
          ctx.lineTo(edge(k + 1), level(k, shift));
        }
      };
      trace(0);
      ctx.lineTo(edge(last + 1), height + 1);
      ctx.lineTo(edge(first), height + 1);
      ctx.closePath();
      ctx.fillStyle = "#0e0f12";
      ctx.fill();
      if (!probe) {
        trace(0);
        ctx.strokeStyle = "#4a4d55";
        ctx.lineWidth = 1;
        ctx.stroke();
        if (s >= 20) {
          ctx.setLineDash([3, 4]);
          ctx.strokeStyle = "rgba(233, 196, 106, 0.55)";
          for (const shift of [1, -1]) {
            trace(shift);
            ctx.stroke();
          }
          ctx.setLineDash([]);
        }
      }
    } else if (!probe) {
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = "#8c8f97";
      ctx.beginPath();
      ctx.moveTo(0, yOf(smoothHorizonDeg(elevM + mastM)));
      ctx.lineTo(width, yOf(smoothHorizonDeg(elevM + mastM)));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 3. Labels, on top. Probe mode draws none, so the browser tests count only real pixels.
    if (!probe) {
      ctx.font = "12px 'IBM Plex Sans', sans-serif";
      ctx.textBaseline = "middle";
      const step = tickStep(s);
      const decimals = step < 1 ? 1 : 0;
      ctx.fillStyle = "#8c8f97";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
      ctx.lineWidth = 1;
      for (let az = Math.ceil((shown.az - Math.min(180, halfField)) / step) * step; az <= shown.az + Math.min(180, halfField); az += step) {
        const wrapped = ((az % 360) + 360) % 360;
        const x = width / 2 + (az - shown.az) * s;
        ctx.textAlign = "center";
        ctx.fillText(`${COMPASS[Math.round(wrapped)] ? `${COMPASS[Math.round(wrapped)]} ` : ""}${wrapped.toFixed(decimals)}°`, x, height - 12);
      }
      const halfHeight = height / (2 * s);
      for (let el = Math.ceil(Math.max(-90, shown.el - halfHeight) / step) * step; el <= Math.min(90, shown.el + halfHeight); el += step) {
        ctx.beginPath();
        ctx.moveTo(0, yOf(el));
        ctx.lineTo(width, yOf(el));
        ctx.stroke();
        ctx.textAlign = "left";
        if (yOf(el) < height - 28) ctx.fillText(`${el.toFixed(decimals)}°`, 8, yOf(el) - 8);
      }
      ctx.textAlign = "center";
      ctx.fillStyle = "#dcd9d2";
      ctx.fillText("Sun", sun.x, sun.y - sun.ry - 12);
      if (skyline && earthVisibility && earthVisibility.fraction_high === 0) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "#8c8f97";
        ctx.beginPath();
        ctx.ellipse(earthDisc.x, earthDisc.y, earthDisc.rx, earthDisc.ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillText("Earth, below the horizon", earthDisc.x, earthDisc.y - earthDisc.ry - 12);
      } else {
        ctx.fillText("Earth", earthDisc.x, earthDisc.y - earthDisc.ry - 12);
      }
      if (!skyline) {
        ctx.textAlign = "left";
        ctx.fillStyle = "#8c8f97";
        ctx.fillText("Smooth-sphere horizon: no terrain data for this point", 60, yOf(smoothHorizonDeg(elevM + mastM)) + 12);
      }
    }

    const target = probe === "earth" ? earthDisc : sun;
    Object.assign(canvas.dataset, {
      cx: target.x.toFixed(2), cy: target.y.toFixed(2), rx: target.rx.toFixed(3), ry: target.ry.toFixed(3),
      sunFraction: sunVisibility ? String(sunVisibility.fraction) : "",
      earthLit: String(earthView.lit),
      magnify: String(factor),
      drawn: String(Boolean(sunImage.current) && (probe === "earth" || Boolean(earth.current?.material.map) || probe === "sun")),
    });
  }, [size, shown?.az, shown?.el, shown?.scale, factor, directions, earthView, skyline, loaded, probe, sunVisibility, earthVisibility, elevM, mastM]);

  const zoom = (by: number) => view && setView({ ...view, scale: Math.min(Math.max(view.scale * by, size.width / 360), 6000) });
  return (
    <div
      className="scene scene-sky"
      ref={hostRef}
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerLeave={() => {
        drag.current = null;
      }}
      onPointerMove={(event) => {
        if (!drag.current || !view || probe) return;
        const az = (((view.az - (event.clientX - drag.current.x) / view.scale) % 360) + 360) % 360;
        const el = Math.min(90, Math.max(-90, view.el + (event.clientY - drag.current.y) / view.scale));
        setView({ ...view, az, el });
        drag.current = { x: event.clientX, y: event.clientY };
      }}
      onWheel={(event) => zoom(event.deltaY < 0 ? 1.25 : 0.8)}
    >
      <canvas ref={canvasRef} className="sky-canvas" data-testid="sky" style={{ width: size.width, height: size.height }} />
      <div className="scene-tools">
        <button type="button" onClick={() => setView({ az: 180, el: 0, scale: size.width / 360 })}>Whole sky</button>
        <button type="button" onClick={() => setView(defaultView("sun", 6))}>Find Sun</button>
        <button type="button" onClick={() => setView(defaultView("earth", 12))}>Find Earth</button>
        <button type="button" aria-pressed={magnify} onClick={() => setMagnify(!magnify)}>Magnify ×{MAGNIFY}</button>
      </div>
      <p className="scene-note">
        {magnify && <strong>Sun and Earth drawn {MAGNIFY}× larger than real; their positions are unchanged. </strong>}
        Azimuth across, elevation up, same scale both ways. {skyline ? "Dashed gold lines: the skyline’s uncertainty. " : ""}
        Earth’s phase is exact; its rotation is approximate (which side faces the Moon is not in the data). Drag to look, scroll to zoom.
      </p>
    </div>
  );
}
