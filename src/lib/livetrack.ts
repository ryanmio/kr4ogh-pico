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
import { parseUtc } from "./format";
import { pruneGhosts, settledGhosts } from "./ghosts";
import { believe } from "./spoof";
import { fetchWindow, mergeTrack, type FlightSpec } from "./wspr/track";
import type { GhostPoint, TrackPoint } from "./types";

/** What the refresh needs to know about a flight: the channel to query,
 * and the window it flew in. The window matters when two flights share a
 * callsign and a channel, which is the same signal to wspr.live: the only
 * thing that tells them apart is when they were up. */
export type LiveFlight = FlightSpec & {
  launch_utc?: string | null;
  end_utc?: string | null;
};

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
  /** The slots heard without telemetry, brought up to date the same way. */
  ghosts: GhostPoint[];
  /** The fixes set aside as GPS-spoofed (lib/spoof.ts). */
  spoofed: TrackPoint[];
  /** Reports, of either kind, that were not in the bundled data. */
  added: number;
  /** Null when the update succeeded; the failure otherwise. */
  error: Error | null;
}

export async function refreshTrack(
  flight: LiveFlight, bundled: TrackPoint[], bundledGhosts: GhostPoint[] = [],
  bundledSpoofed: TrackPoint[] = [],
  /** `detect` false keeps spoofed fixes on the track (lib/spoof.ts). */
  opts: { signal?: AbortSignal; detect?: boolean } = {},
): Promise<LiveTrackResult> {
  const now = new Date();
  // A ghost younger than one cycle is held back (lib/ghosts.ts,
  // GHOST_HOLD_MS): its telemetry is most likely still on the way.
  const unchanged = {
    track: bundled, ghosts: settledGhosts(bundledGhosts, now), spoofed: bundledSpoofed, added: 0,
  };
  // Every fix decoded so far, believed or not: the spoof test is re-run
  // over all of them, since a fix is judged against the ones before it.
  const raw = mergeTrack(bundled, bundledSpoofed);
  // The window opens at the last full fix even when ghosts are newer: a
  // ghost's slot is one the slower stations may yet complete, so it is
  // asked about again until a fix lands there. A spoofed fix counts: its
  // slot is complete, and a spoof lasting hours would otherwise be fetched
  // again on every refresh.
  // A hand-entered spoofed fix (FlightMeta.spoofed) does not count: the
  // decoder never reached its slot, and the fixes before it may not have
  // been fetched yet.
  const last = raw.findLast((p) => p.spoof_note == null);
  const lastMs = last ? Date.parse(last.utc.replace(" ", "T") + "Z") : NaN;
  let fromMs = Number.isFinite(lastMs)
    ? Math.max(lastMs - OVERLAP_MS, now.getTime() - MAX_LOOKBACK_MS)
    : now.getTime() - MAX_LOOKBACK_MS;
  // A window ending slightly in the future costs nothing and avoids losing
  // a fix to clock skew between this browser and wspr.live.
  let toMs = now.getTime() + 60_000;
  // Never before the launch nor after the end: on a reused channel, what
  // lies outside is another flight.
  if (flight.launch_utc) fromMs = Math.max(fromMs, parseUtc(flight.launch_utc).getTime());
  if (flight.end_utc) toMs = Math.min(toMs, parseUtc(flight.end_utc).getTime());
  if (toMs <= fromMs) return { ...unchanged, error: null };

  try {
    // Every fix decoded so far goes in as context: the inferred pairing
    // tier measures each candidate against the last fix before it.
    // Nor is it context for decoding.
    const fresh = await fetchWindow(
      flight, new Date(fromMs), new Date(toMs), opts.signal,
      raw.filter((p) => p.spoof_note == null));
    const known = new Set(raw.map((p) => p.utc));
    const knownGhosts = new Set(bundledGhosts.map((g) => g.utc));
    // Re-derived over the whole merged track, not just the tail: a
    // saturated fix at the old end had no fixes after it to measure
    // against, and now it does (lib/speed.ts), and the spoof test needs
    // the fixes before each one (lib/spoof.ts).
    const all = mergeTrack(raw, fresh.track);
    const b = believe(all, mergeTrack(bundledGhosts, fresh.ghosts), opts.detect);
    // A bundled ghost whose slot has since completed is dropped, and so
    // is a fresh ghost from a slot the bundled track already has a fix
    // for: the window overlaps the bundled end on purpose. A spoofed fix
    // completes its slot as much as a believed one does. A ghost still
    // inside its hold is left out for now; the window opens at the last
    // fix, so the next refresh asks about its slot again.
    const ghosts = settledGhosts(pruneGhosts(all, b.ghosts), now);
    return {
      track: b.track,
      ghosts,
      spoofed: b.spoofed,
      // A ghost counts as new when it is first shown, which for a held one
      // is a refresh after it was first heard: the map redraws to add it.
      added: fresh.track.filter((p) => !known.has(p.utc)).length
        + ghosts.filter((g) => !knownGhosts.has(g.utc)).length,
      error: null,
    };
  } catch (err) {
    return { ...unchanged, error: err instanceof Error ? err : new Error(String(err)) };
  }
}
