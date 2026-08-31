/** Bring a bundled track up to date from wspr.live, in the browser.
 *
 * The page ships with the track as of the last export, so the balloon is on
 * screen at first paint with no network round trip. This then asks wspr.live
 * for everything since the last bundled fix and merges the result, which is
 * what makes the page current rather than merely fast.
 *
 * Failure is a normal state, not an error page: if wspr.live is slow, down,
 * or blocked, the bundled track still renders and the caller shows when it
 * was last updated. Nothing here can leave the page emptier than it started.
 */
import { fetchTrack, mergeTrack, type FlightSpec } from "./wspr/track";
import type { TrackPoint } from "./types";

/** How far back to look when the bundled track is empty or ancient.
 *
 * This is the safety net, not the normal case: the window normally starts at
 * the last bundled fix, minutes or hours back. It only binds when the
 * committed export is stale, and it has to exceed the export's own cadence
 * or a gap opens in the middle of the track -- the browser would fetch the
 * recent end and merge it onto an old seed with nothing in between.
 *
 * The export runs daily, so three days leaves room for two consecutive
 * failures. wspr.live asks that every query be bounded, and three days of one
 * flight's spots is a few MB in the worst case, which only a neglected site
 * ever pays. */
const MAX_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

/** Overlap re-queried before the last bundled fix. A fix is only decodable
 * once both its Regular and Telemetry spots have been reported, and stations
 * report at their own pace, so the most recent bundled fix may have been
 * decoded from fewer receivers than are now available. Re-reading a little
 * history lets those rows settle. */
const OVERLAP_MS = 20 * 60 * 1000;

export interface LiveTrackResult {
  track: TrackPoint[];
  /** Points that were not in the bundled track. */
  added: number;
  /** Null when the update succeeded; the failure otherwise. */
  error: Error | null;
}

export async function refreshTrack(
  flight: FlightSpec, bundled: TrackPoint[], signal?: AbortSignal,
): Promise<LiveTrackResult> {
  const now = new Date();
  const last = bundled.at(-1);
  const lastMs = last ? Date.parse(last.utc.replace(" ", "T") + "Z") : NaN;
  const from = Number.isFinite(lastMs)
    ? new Date(Math.max(lastMs - OVERLAP_MS, now.getTime() - MAX_LOOKBACK_MS))
    : new Date(now.getTime() - MAX_LOOKBACK_MS);

  try {
    // A window ending slightly in the future costs nothing and avoids losing
    // a fix to clock skew between this browser and wspr.live.
    const fresh = await fetchTrack(flight, from, new Date(now.getTime() + 60_000), signal);
    const known = new Set(bundled.map((p) => p.utc));
    return {
      track: mergeTrack(bundled, fresh),
      added: fresh.filter((p) => !known.has(p.utc)).length,
      error: null,
    };
  } catch (err) {
    return {
      track: bundled,
      added: 0,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
