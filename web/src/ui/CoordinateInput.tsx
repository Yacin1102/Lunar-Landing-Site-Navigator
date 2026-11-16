import { useState } from "react";
import { validateCoordinates } from "../lib/geometry";

/**
 * Latitude and longitude fields that open a custom point.
 *
 * The values are checked by `validateCoordinates` against the service region of the manifest.
 * A value that is not accepted is not opened; the message says what is wrong and what is allowed.
 */
export function CoordinateInput({ region, onOpen }: { region: { lat_min: number; lat_max: number }; onOpen: (lat: number, lon: number) => void }) {
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [error, setError] = useState<string>();
  return (
    <form
      className="coords"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const check = validateCoordinates(lat, lon, region);
        if (check.ok) {
          setError(undefined);
          onOpen(check.lat, check.lon);
        } else {
          setError(check.message);
        }
      }}
    >
      <h2 className="group-title">Open a point by coordinates</h2>
      <div className="coords-row">
        <label className="field">
          <span>Latitude</span>
          <input inputMode="decimal" value={lat} onChange={(event) => setLat(event.target.value)} placeholder="-89.45" aria-invalid={Boolean(error)} />
          <span>°</span>
        </label>
        <label className="field">
          <span>Longitude</span>
          <input inputMode="decimal" value={lon} onChange={(event) => setLon(event.target.value)} placeholder="-137.16" aria-invalid={Boolean(error)} />
          <span>° E</span>
        </label>
      </div>
      <button type="submit" className="button">Open point</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}
