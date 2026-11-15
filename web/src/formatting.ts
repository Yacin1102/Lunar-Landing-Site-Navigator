/** Format a UTC millisecond duration as days, hours, and minutes. */
export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return "No crossing in range";
  const totalMinutes = Math.max(0, Math.round(durationMs / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return `${days ? `${days}d ` : ""}${hours}h ${minutes}m`;
}

/** Format watts as an integer with a stable unit. */
export function formatPower(powerW: number): string {
  return `${Math.round(powerW)} W`;
}

/** Format a fraction as an integer percentage. */
export function formatPercent(fraction: number): string {
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

/** Format an angular value to one decimal place in degrees. */
export function formatDegrees(degrees: number): string {
  return `${degrees.toFixed(1)}°`;
}

/** Format a UTC instant for the browser's datetime-local input. */
export function toDateTimeInputValue(timeMs: number): string {
  const date = new Date(timeMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** Parse a browser datetime-local value as UTC milliseconds. */
export function fromDateTimeInputValue(value: string): number {
  return Date.parse(`${value}:00Z`);
}

/** Format the selected UTC instant in a compact, explicit UTC display. */
export function formatUtc(timeMs: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timeMs)) + " UTC";
}

/** Format the selected instant in the browser's local timezone for orientation only. */
export function formatLocalTime(timeMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timeMs));
}
