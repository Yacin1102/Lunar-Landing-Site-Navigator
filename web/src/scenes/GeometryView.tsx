import { interpolateBody } from "../../engine/astro";
import type { DataBundle } from "../../engine/runtime-types";
import { earthMonthFile, earthPhaseAngleDeg, lengthKm, litFraction, logRadius, separationDeg } from "../lib/geometry";

/** The logarithmic distance axis: 10^5 km at the inner ring, 10^9 km at the outer one. */
const MIN_KM = 1e5;
const MAX_KM = 1e9;
const R0 = 60;
const R1 = 430;

/**
 * Scene 4, geometry: where the Sun and the Earth are, seen from the Moon, at the selected time.
 *
 * How it works: the picture is the plane that contains the Moon, the Earth and the Sun. The
 * Earth is placed to the right; the Sun is placed at the true angle between the two directions
 * (from the timetable vectors). Distance from the Moon is on a logarithmic axis, because the
 * Sun is about 390 times farther than the Earth; the rings are labelled with their distances.
 * The icons are the real Sun and Earth pictures and are not to scale, which the picture says.
 */
export function GeometryView({ bundle, timeMs }: { bundle: DataBundle; timeMs: number }) {
  const { label, values } = bundle.ephemeris;
  const sun = interpolateBody(values, label, timeMs, 0);
  const earth = interpolateBody(values, label, timeMs, 3);
  const sunKm = lengthKm(sun);
  const earthKm = lengthKm(earth);
  const angle = separationDeg(sun, earth);
  const lit = litFraction(earthPhaseAngleDeg(sun, earth, { x: 0, y: 0, z: 0 }));
  const radians = (angle * Math.PI) / 180;
  const earthR = logRadius(earthKm, MIN_KM, MAX_KM, R0, R1);
  const sunR = logRadius(sunKm, MIN_KM, MAX_KM, R0, R1);
  const sunAt = { x: sunR * Math.cos(radians), y: -sunR * Math.sin(radians) };
  const rings = [1e5, 1e6, 1e7, 1e8, 1e9];
  const km = (value: number) => `${Math.round(value).toLocaleString("en-GB")} km`;

  return (
    <div className="scene scene-geometry" data-ready="true">
      <svg viewBox="-500 -470 1000 940" role="img" aria-label={`Moon, Earth and Sun. The Sun is ${angle.toFixed(1)} degrees from the Earth as seen from the Moon.`}>
        <defs>
          <clipPath id="earth-clip"><circle cx={earthR} cy="0" r="17" /></clipPath>
        </defs>
        {rings.map((ring) => {
          const r = logRadius(ring, MIN_KM, MAX_KM, R0, R1);
          return (
            <g key={ring}>
              <circle className="geo-ring" cx="0" cy="0" r={r} />
              <text className="geo-tick" x="0" y={r + 14} textAnchor="middle">10^{Math.log10(ring)} km</text>
            </g>
          );
        })}
        <line className="geo-line" x1="0" y1="0" x2={earthR} y2="0" />
        <line className="geo-line" x1="0" y1="0" x2={sunAt.x} y2={sunAt.y} />
        <path className="geo-arc" d={`M ${R0 * 0.7} 0 A ${R0 * 0.7} ${R0 * 0.7} 0 0 0 ${R0 * 0.7 * Math.cos(radians)} ${-R0 * 0.7 * Math.sin(radians)}`} />
        <circle className="geo-moon" cx="0" cy="0" r="9" />
        <text className="geo-label" x="0" y="-18" textAnchor="middle">Moon</text>
        {/* Square crop from the middle of the month's map (longitude 0), clipped to a circle. */}
        <image href={`/assets/${earthMonthFile(timeMs)}`} x={earthR - 34} y="-17" width="68" height="34" clipPath="url(#earth-clip)" preserveAspectRatio="none" />
        <text className="geo-label" x={earthR} y="-30" textAnchor="middle">Earth</text>
        <text className="geo-value" x={earthR} y="38" textAnchor="middle" data-testid="earth-distance">{km(earthKm)}</text>
        <image href="/assets/sun/sun_hmi_2048.png" x={sunAt.x - 20} y={sunAt.y - 20} width="40" height="40" style={{ filter: "brightness(2.4)" }} />
        <text className="geo-label" x={sunAt.x} y={sunAt.y - 30} textAnchor="middle">Sun</text>
        <text className="geo-value" x={sunAt.x} y={sunAt.y + 38} textAnchor="middle" data-testid="sun-distance">{km(sunKm)}</text>
        <text className="geo-value" x={R0 * 0.9 * Math.cos(radians / 2)} y={-R0 * 0.9 * Math.sin(radians / 2)} data-testid="separation">{angle.toFixed(1)}°</text>
      </svg>
      <p className="scene-note">
        The angle between the Sun and the Earth is true. Distances from the Moon’s centre are on a logarithmic scale (rings). Icons are not to scale.
        Earth’s sunlit fraction seen from the Moon: {(lit * 100).toFixed(1)} %.
      </p>
    </div>
  );
}
