import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSavedScenarios, saveScenariosToUrl } from "./url-state";

describe("scenario URL state", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      location: { href: "http://localhost/" },
      history: { replaceState: vi.fn() },
    });
  });

  it("round-trips up to four site/date scenarios", () => {
    const scenarios = [
      { siteId: "mock_a", dateMs: 1000 },
      { siteId: "mock_b", dateMs: 2000 },
      { siteId: "mock_c", dateMs: 3000 },
      { siteId: "mock_d", dateMs: 4000 },
      { siteId: "mock_e", dateMs: 5000 },
    ];
    saveScenariosToUrl(scenarios);
    expect(readSavedScenarios("?scenarios=mock_a%2C1000%7Cmock_b%2C2000%7Cmock_c%2C3000%7Cmock_d%2C4000%7Cmock_e%2C5000")).toEqual(scenarios.slice(0, 4));
  });
});
