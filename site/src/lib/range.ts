/** Which slice of a flight the charts show.
 *
 * A float flight ruins its own charts. On this flight the ascent took 3.7
 * hours to climb 1,860 -> 10,520 m, and the float since then has varied by
 * 160 m, which is 1.5% of full scale. After a week aloft the ascent is 2%
 * of the chart's width and the float is a flat line across the rest: both
 * axes are wasted.
 *
 * Slicing the track fixes both at once, because renderChart takes its y
 * scale from the values it is handed and its x domain from the range it is
 * given. Zooming to the float rescales the y axis to the float's own band,
 * where the diurnal altitude wobble becomes visible instead of invisible.
 *
 * This applies to the charts only. The map always shows the whole flight
 * with the current position on it, and the stats always describe now --
 * "last heard" and "altitude" would be lies otherwise.
 */
import type { TrackPoint } from "./types";

export type Range = "all" | "ascent" | "recent";

export const RANGE_LABELS: Record<Range, string> = {
  all: "Whole flight",
  ascent: "Ascent",
  recent: "Last 24 h",
};

export const RANGES: Range[] = ["all", "ascent", "recent"];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Below this the controls are pointless: the whole flight still *is* the
 * ascent, and every range would show the same thing. */
export const RANGE_MIN_SPAN_MS = 6 * 60 * 60 * 1000;

function ms(utc: string): number {
  return Date.parse(utc.replace(" ", "T") + "Z");
}

export function spanMs(track: TrackPoint[]): number {
  if (track.length < 2) return 0;
  return ms(track[track.length - 1]!.utc) - ms(track[0]!.utc);
}

/** End of the climb: the first fix within 2% of the flight's peak altitude.
 *
 * Taken against the peak rather than the argmax, because a float usually
 * drifts a little higher hours later as the gas warms; keying on the argmax
 * would stretch "ascent" across the whole flight. Two percent of a 10 km
 * ceiling is 200 m, comfortably inside one 20 m altitude step.
 */
export function ascentEndIndex(track: TrackPoint[]): number {
  if (track.length < 3) return track.length - 1;
  const peak = Math.max(...track.map((p) => p.altitude_m));
  const i = track.findIndex((p) => p.altitude_m >= peak * 0.98);
  // Always keep a couple of points, even for a flight that launched at float.
  return Math.max(i, 2);
}

export function filterRange(track: TrackPoint[], range: Range): TrackPoint[] {
  if (track.length === 0 || range === "all") return track;
  if (range === "ascent") return track.slice(0, ascentEndIndex(track) + 1);
  const cutoff = ms(track[track.length - 1]!.utc) - DAY_MS;
  const sliced = track.filter((p) => ms(p.utc) >= cutoff);
  // A quiet night can leave the last 24 h nearly empty; a chart of one point
  // is worse than no zoom at all.
  return sliced.length >= 2 ? sliced : track;
}
