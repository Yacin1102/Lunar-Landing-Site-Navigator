import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const site = {
  id: "mock_site",
  name: "Mock site",
  lat: -89,
  lon: 0,
  category: "test",
  has_terrain: true,
  has_shade_grid: true,
};

const point = {
  timeMs: 1794830400000,
  sun: { az_deg: 20, el_deg: 5, distance_km: 149597870 },
  earth: { az_deg: 180, el_deg: 4, distance_km: 384400 },
  sunFraction: 0.8,
  earthFraction: 1,
  sunStatus: "visible" as const,
  earthStatus: "visible" as const,
  batteryWh: 1800,
};

const summary = {
  site,
  skyline: {
    version: 1,
    lat: -89,
    lon: 0,
    elev_m: 0,
    mast_m: 2,
    az_step_deg: 90,
    skyline_deg: [0, 0, 0, 0],
    skyline_err_deg: [0.03, 0.03, 0.03, 0.03],
    dem: ["TEST"],
    resolution_m: 20,
    max_reach_km: 100,
  },
  points: [point],
  sunlightHours: 12,
  timeToSunsetMs: 3600000,
  timeToEarthsetMs: 7200000,
  lowestBatteryWh: 1500,
};

vi.mock("../engine/data", () => ({
  loadDataBundle: vi.fn(async () => ({
    manifest: { version: 1, data_kind: "mock", built_ms: 0, service_region: { lat_min: -90, lat_max: -80 }, files: [] },
    sites: [site],
    ephemeris: { label: { t0_ms: 1794787200000, step_s: 3600, count: 1, columns: [], units: "km", frame: "MOON_ME", origin: "MOON", aberration: "NONE" }, values: new Float32Array() },
    skylines: new Map([[site.id, summary.skyline]]),
    terrain: new Map(),
    shade: new Map(),
  })),
}));

vi.mock("../engine/client", () => ({
  evaluateInWorker: vi.fn(async () => ({ events: { sunrise: [], sunset: [point.timeMs + 3600000], earthrise: [], earthset: [point.timeMs + 7200000] } })),
}));

vi.mock("./visual-model", () => ({
  buildTimeline: vi.fn(() => summary),
  elevationRange: vi.fn(() => ({ min: -2, max: 10 })),
  skyBodySize: vi.fn(() => 4),
  skyPoint: vi.fn((azimuth: number, elevation: number) => ({ x: azimuth, y: elevation })),
  timelineBounds: vi.fn((centerMs: number) => ({ startMs: centerMs - 3600000, endMs: centerMs + 3600000, stepMs: 1800000 })),
}));

describe("mission dashboard", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => cleanup());

  it("keeps the first screen focused and opens expert details", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Select site" }) as HTMLSelectElement).value).toBe("mock_site"));
    expect(screen.getByText("Visible")).toBeTruthy();
    expect(screen.getByText("In view")).toBeTruthy();
    expect(screen.getByText("Why the lunar south pole is difficult")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Got it" }));
      fireEvent.click(screen.getByRole("button", { name: "Beginner" }));
    });
    expect(screen.getByText("Expert readout")).toBeTruthy();
  });

  it("opens the details drawer from the top bar", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Select site" }) as HTMLSelectElement).value).toBe("mock_site"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
    });
    expect(screen.getByText("Additional information")).toBeTruthy();
  });

  it("switches from the analytical dashboard to the on-site view", async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Select site" }) as HTMLSelectElement).value).toBe("mock_site"));
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Site view" }));
    });
    expect(screen.getByRole("heading", { name: "Site view" })).toBeTruthy();
    expect(screen.getByText("-89.000° latitude")).toBeTruthy();
  });
});
