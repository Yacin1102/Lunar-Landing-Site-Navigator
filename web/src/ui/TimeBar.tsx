import { formatUtc, fromDateTimeInputValue, toDateTimeInputValue } from "../formatting";

/** Playback speeds: hours of Moon time per second of real time. */
export const SPEEDS = [1, 6, 24, 96];
/** Length of the slider's window, days: a little over one lunar day. */
export const WINDOW_DAYS = 30;

/**
 * Time controls: a UTC date and time field, a slider over a 30-day window that starts at the
 * chosen date, play / pause and a speed.
 *
 * All times are UTC. The date field is clamped to the timetable's span, so no time can be
 * chosen for which the engine has no Sun and Earth positions.
 */
export function TimeBar({
  timeMs, windowStartMs, windowEndMs, spanStartMs, spanEndMs, playing, speed, onTime, onWindowStart, onPlaying, onSpeed,
}: {
  timeMs: number; windowStartMs: number; windowEndMs: number; spanStartMs: number; spanEndMs: number; playing: boolean; speed: number;
  onTime: (timeMs: number) => void; onWindowStart: (timeMs: number) => void; onPlaying: (playing: boolean) => void; onSpeed: (speed: number) => void;
}) {
  return (
    <div className="timebar">
      <button type="button" className="timebar-play" aria-pressed={playing} onClick={() => onPlaying(!playing)}>{playing ? "Pause" : "Play"}</button>
      <label className="timebar-speed">
        <span className="visually-hidden">Speed</span>
        <select value={speed} onChange={(event) => onSpeed(Number(event.target.value))}>
          {SPEEDS.map((hours) => <option key={hours} value={hours}>{hours} h per second</option>)}
        </select>
      </label>
      <input
        className="timebar-slider"
        type="range"
        aria-label={`Time within the ${WINDOW_DAYS} days from the chosen date`}
        min={windowStartMs}
        max={windowEndMs}
        step={600_000}
        value={timeMs}
        onChange={(event) => onTime(Number(event.target.value))}
      />
      <output className="timebar-now" data-testid="time-now">{formatUtc(timeMs)}</output>
      <label className="timebar-date">
        <span>Window starts (UTC)</span>
        <input
          type="datetime-local"
          min={toDateTimeInputValue(spanStartMs)}
          max={toDateTimeInputValue(spanEndMs)}
          value={toDateTimeInputValue(windowStartMs)}
          onChange={(event) => {
            const chosen = fromDateTimeInputValue(event.target.value);
            if (Number.isFinite(chosen)) onWindowStart(Math.min(Math.max(chosen, spanStartMs), spanEndMs));
          }}
        />
      </label>
    </div>
  );
}
