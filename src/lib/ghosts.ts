/** What the track and its ghosts say together.
 *
 * A ghost is a slot where the tracker was heard but only the Regular
 * message arrived (lib/types.ts, GhostPoint). The full fixes are the track;
 * the ghosts sit beside it. These helpers answer the questions that need
 * both: where the balloon was last known to be, and when it was first and
 * last heard at all. Everything about altitude, speed, battery and
 * temperature keeps reading the track alone, because a ghost knows none of
 * those.
 */
import { parseUtc } from "./format";
import type { GhostPoint, TrackPoint } from "./types";

/** Drop every ghost whose slot has a full fix. A refresh can complete a
 * slot that an earlier pass saw only half of, once the slower stations
 * report; the ghost then has nothing left to say. */
export function pruneGhosts(track: TrackPoint[], ghosts: GhostPoint[]): GhostPoint[] {
  const fixed = new Set(track.map((p) => p.utc));
  return ghosts.filter((g) => !fixed.has(g.utc));
}

/** The ghosts newer than the last full fix, oldest first: the coarse tail
 * the balloon has been heard along since it last sent telemetry. Empty
 * whenever a full fix is the newest thing known. */
export function trailingGhosts(track: TrackPoint[], ghosts: GhostPoint[]): GhostPoint[] {
  const lastFix = track.at(-1)?.utc ?? "";
  return ghosts.filter((g) => g.utc > lastFix);
}

export interface LastKnown {
  utc: string;
  lat: number;
  lon: number;
  /** True when the newest report is a ghost: the position is a grid square,
   * not a fix, and the beacon on the map says so. */
  coarse: boolean;
}

/** Where the balloon was last heard, whichever kind of report that was. */
export function lastKnown(track: TrackPoint[], ghosts: GhostPoint[]): LastKnown | null {
  const g = trailingGhosts(track, ghosts).at(-1);
  if (g) return { utc: g.utc, lat: g.lat, lon: g.lon, coarse: true };
  const p = track.at(-1);
  return p ? { utc: p.utc, lat: p.lat, lon: p.lon, coarse: false } : null;
}

/** When the tracker was first and last heard at all. A flight often opens
 * on a ghost (the launch slot, heard by one station on the ground) and
 * closes on a run of them (sunset, the telemetry message lost first), and
 * "time in the air" should count both ends. */
export function heardBounds(
  track: TrackPoint[], ghosts: GhostPoint[],
): { firstUtc: string; lastUtc: string } | null {
  const utcs = [...track.map((p) => p.utc), ...ghosts.map((g) => g.utc)];
  if (!utcs.length) return null;
  utcs.sort();
  return { firstUtc: utcs[0]!, lastUtc: utcs[utcs.length - 1]! };
}

/** Shift a longitude by whole turns until it sits within half a turn of a
 * reference: how a ghost is placed on a track whose longitudes have been
 * unwrapped (lib/basemap.ts) so a Pacific crossing draws as one line. */
export function unwrapNear(lon: number, ref: number): number {
  let out = lon;
  while (out - ref > 180) out -= 360;
  while (out - ref < -180) out += 360;
  return out;
}

/** The unwrapped longitude for each ghost, each placed next to the track
 * point nearest it in time. With no track at all the ghosts are unwrapped
 * against each other. */
export function unwrapGhostLons(
  track: TrackPoint[], trackLons: number[], ghosts: GhostPoint[],
): number[] {
  if (!track.length) {
    let ref: number | null = null;
    return ghosts.map((g) => {
      const lon = ref === null ? g.lon : unwrapNear(g.lon, ref);
      ref = lon;
      return lon;
    });
  }
  const t = track.map((p) => parseUtc(p.utc).getTime());
  return ghosts.map((g) => {
    const at = parseUtc(g.utc).getTime();
    let best = 0;
    for (let i = 1; i < t.length; i++) {
      if (Math.abs(t[i]! - at) < Math.abs(t[best]! - at)) best = i;
    }
    return unwrapNear(g.lon, trackLons[best]!);
  });
}
