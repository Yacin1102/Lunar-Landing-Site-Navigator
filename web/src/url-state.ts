export interface SavedScenario {
  siteId: string;
  dateMs: number;
}

/** Read up to four scenario selections from the URL so comparisons are shareable. */
export function readSavedScenarios(search = window.location.search): SavedScenario[] {
  const value = new URLSearchParams(search).get("scenarios");
  if (!value) return [];
  return value.split("|").slice(0, 4).flatMap((entry) => {
    const [siteId, rawDate] = entry.split(",");
    const dateMs = Number(rawDate);
    return siteId && Number.isFinite(dateMs) ? [{ siteId, dateMs }] : [];
  });
}

/** Write the current comparison set into the address bar without reloading the page. */
export function saveScenariosToUrl(scenarios: SavedScenario[]): void {
  const url = new URL(window.location.href);
  if (scenarios.length === 0) {
    url.searchParams.delete("scenarios");
  } else {
    url.searchParams.set(
      "scenarios",
      scenarios.slice(0, 4).map((scenario) => `${scenario.siteId},${scenario.dateMs}`).join("|"),
    );
  }
  window.history.replaceState({}, "", url);
}
