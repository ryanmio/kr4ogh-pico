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
import { BEND_GAP_MS } from "./basemap";
import { haversineKm, parseUtc } from "./format";
import type { GhostPoint, TrackPoint } from "./types";

/** Drop every ghost whose slot has a full fix. A refresh can complete a
 * slot that an earlier pass saw only half of, once the slower stations
 * report; the ghost then has nothing left to say. */
export function pruneGhosts(track: TrackPoint[], ghosts: GhostPoint[]): GhostPoint[] {
  const fixed = new Set(track.map((p) => p.utc));
  return ghosts.filter((g) => !fixed.has(g.utc));
}

/** How long a ghost is held back before it is drawn. A cycle sends its
 * Regular message first and the telemetry two minutes later, and the
 * stations' reports reach wspr.live minutes after that, so for a few
 * minutes of every cycle the newest slot looks like a ghost even when its
 * fix is on the way. Drawn at once, the balloon would hop to the middle of
 * a grid square and back every ten minutes. Held for a cycle, a ghost
 * appears only when its telemetry really was lost. */
export const GHOST_HOLD_MS = 10 * 60 * 1000;

/** A ghost heard after a silence longer than this is not held. The hold
 * stops the beacon hopping away from a fix ten minutes old and back; after
 * an hour or a night of nothing there is no such fix to hop from, and the
 * first report back is the one everyone is waiting for. */
export const GHOST_HOLD_SILENCE_MS = 60 * 60 * 1000;

/** The ghosts ready to show: every one whose slot began at least
 * GHOST_HOLD_MS before `now`, and any younger one that ends a silence of
 * more than GHOST_HOLD_SILENCE_MS. `track` is every fix decoded, spoofed
 * ones included, since they too are the tracker being heard. A closed
 * flight's ghosts are all old enough. */
export function settledGhosts(
  ghosts: GhostPoint[], track: { utc: string }[], now: Date = new Date(),
): GhostPoint[] {
  const cutoff = now.getTime() - GHOST_HOLD_MS;
  return ghosts.filter((g) => {
    const t = parseUtc(g.utc).getTime();
    if (t <= cutoff) return true;
    // The newest report of either kind before this one.
    let prev = -Infinity;
    for (const r of [...track, ...ghosts]) {
      const h = parseUtc(r.utc).getTime();
      if (h < t && h > prev) prev = h;
    }
    return t - prev > GHOST_HOLD_SILENCE_MS;
  });
}

/** The ghosts newer than the last full fix, oldest first: the coarse tail
 * the balloon has been heard along since it last sent telemetry. Empty
 * whenever a full fix is the newest thing known. */
export function trailingGhosts(track: TrackPoint[], ghosts: GhostPoint[]): GhostPoint[] {
  const lastFix = track.at(-1)?.utc ?? "";
  return ghosts.filter((g) => g.utc > lastFix);
}

/** How far from every fix, before and after, a ghost has to be heard for
 * the line to be routed through it: the silence the line already treats as
 * a hole (lib/basemap.ts). Nearly every ghost is nearer a fix than this --
 * the slot before the first fix of a morning, the ones after the last of
 * an evening -- and the fix says where the balloon was far better than the
 * square does. */
export const WAYPOINT_GAP_MS = BEND_GAP_MS;

/** How far a ghost's square has to be from the position before it on the
 * line, and from the fix after it. A square is about 110 km by 150 km and
 * the balloon may be anywhere in it, so its centre is up to 95 km wrong: a
 * line bent to reach a centre one square away would be drawing that error.
 * It is also what makes one waypoint of a run of ghosts in one square. */
export const WAYPOINT_MIN_KM = 150;

/** The ghosts the track is routed through: the ones heard deep enough in a
 * silence to be the only word on where the balloon was.
 *
 * Usually the tracker loses a telemetry message here and there and the
 * fixes either side say where it was; those ghosts sit beside the line and
 * change nothing. But a tracker can go a whole day heard only by its
 * Regular message (PT-02 on 19 Nov 2026, over the Gulf of Alaska: no fix
 * for two days, two grid squares), and then a line drawn from the last fix
 * straight to the next one ignores the only positions there are. A ghost
 * is a waypoint when no fix was decoded within WAYPOINT_GAP_MS of it on
 * either side and its square is WAYPOINT_MIN_KM clear of the position
 * before it and of the fix after.
 *
 * Both lists oldest first. The answer can change as the flight goes on: a
 * fix decoded within two hours after a ghost takes it off the line again,
 * which is the rule working, since that fix is now the better position. */
export function waypoints(track: TrackPoint[], ghosts: GhostPoint[]): GhostPoint[] {
  const fixMs = track.map((p) => parseUtc(p.utc).getTime());
  const out: GhostPoint[] = [];
  let next = 0;
  for (const g of ghosts) {
    const t = parseUtc(g.utc).getTime();
    while (next < track.length && fixMs[next]! <= t) next++;
    const before = track[next - 1];
    const after = track[next];
    if (before && t - fixMs[next - 1]! < WAYPOINT_GAP_MS) continue;
    if (after && fixMs[next]! - t < WAYPOINT_GAP_MS) continue;
    // The position before this one on the line: the fix, or a waypoint
    // already taken since it.
    const way = out.at(-1);
    const prev = way && (!before || way.utc > before.utc) ? way : before;
    if (prev && haversineKm(prev.lat, prev.lon, g.lat, g.lon) < WAYPOINT_MIN_KM) continue;
    if (after && haversineKm(g.lat, g.lon, after.lat, after.lon) < WAYPOINT_MIN_KM) continue;
    out.push(g);
  }
  return out;
}

/** The ghosts the drawn line passes through, oldest first: the waypoints,
 * and the newest ghost of all when it is newer than the last fix. That one
 * is where the beacon stands, so the line has to reach it whether or not
 * it would make a waypoint; once a fix follows it is judged like any
 * other. Left out when it shares a square with the waypoint before it,
 * where the line already ends. */
export function lineGhosts(track: TrackPoint[], ghosts: GhostPoint[]): GhostPoint[] {
  const way = waypoints(track, ghosts);
  const newest = trailingGhosts(track, ghosts).at(-1);
  if (!newest || way.includes(newest)) return way;
  const last = way.at(-1);
  const lastFix = track.at(-1)?.utc ?? "";
  if (last && last.utc > lastFix && last.grid4 === newest.grid4) return way;
  return [...way, newest];
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
 * "time in the air" should count both ends. A fix set aside as GPS-spoofed
 * (lib/spoof.ts) was heard all the same, and counts too. */
export function heardBounds(
  track: TrackPoint[], ghosts: GhostPoint[], spoofed: TrackPoint[] = [],
): { firstUtc: string; lastUtc: string } | null {
  const utcs = [...track, ...ghosts, ...spoofed].map((p) => p.utc);
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
  track: TrackPoint[], trackLons: number[], ghosts: Pick<GhostPoint, "utc" | "lon">[],
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
