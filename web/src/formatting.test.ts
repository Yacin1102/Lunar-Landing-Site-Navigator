import { describe, expect, it } from "vitest";
import { formatDegrees, formatDuration, formatLocalTime, formatPercent, formatPower, formatUtc, fromDateTimeInputValue, toDateTimeInputValue } from "./formatting";

describe("display formatting", () => {
  it("formats durations, powers, angles, and percentages consistently", () => {
    expect(formatDuration(90061000)).toBe("1d 1h 1m");
    expect(formatPower(12.6)).toBe("13 W");
    expect(formatDegrees(1.26)).toBe("1.3°");
    expect(formatPercent(0.356)).toBe("36%");
  });

  it("round-trips a UTC datetime-local value", () => {
    const timeMs = Date.UTC(2026, 10, 16, 12, 30);
    expect(fromDateTimeInputValue(toDateTimeInputValue(timeMs))).toBe(timeMs);
    expect(formatUtc(timeMs)).toContain("UTC");
    expect(formatLocalTime(timeMs)).toContain("2026");
  });
});
