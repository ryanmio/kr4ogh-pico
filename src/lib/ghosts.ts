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
import { GRID4_SLACK_KM, SPOOF_SQUARE_WINDOW_MS, unreachable } from "./spoof";
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

/** How far from the fix before it, and from the fix after, a ghost has to
 * be heard for the track to be routed through it: the silence the line
 * already treats as a hole (lib/basemap.ts). Nearly every ghost is nearer
 * a fix than this -- the slot before the first fix of a morning, the ones
 * after the last of an evening -- and the fix says where the balloon was
 * far better than the square does. */
export const WAYPOINT_GAP_MS = BEND_GAP_MS;

/** How far a ghost's square has to be from the position before it on the
 * line, and from the fix after it. A square is about 110 km by 150 km and
 * the balloon may be anywhere in it, so its centre is up to 95 km wrong: a
 * line bent to reach a centre one square away would be drawing that error.
 * It is also what makes one waypoint of a run of ghosts in one square. */
export const WAYPOINT_MIN_KM = 150;

/** How much longer the way round by a ghost may be than the straight way
 * between the fixes either side of it. Measured on the first eight
 * flights, between fixes half a day to two and a half days apart, 95% of
 * the balloon's own positions were within this, and the rest were loops
 * in slack air. A square further out than this is possible, but nothing
 * says so except the square itself, and that is not enough to move the
 * track. */
export const WAYPOINT_MAX_DETOUR = 1.5;

/** The ghosts the track is routed through: the ones heard deep enough in a
 * silence to be the only word on where the balloon was, and that the fixes
 * either side of the silence bear out.
 *
 * Usually the tracker loses a telemetry message here and there and the
 * fixes either side say where it was; those ghosts sit beside the line and
 * change nothing. But a tracker can go a whole day heard only by its
 * Regular message (PT-02 on 19 Nov 2026, over the Gulf of Alaska: no fix
 * for two days, two grid squares), and then a line drawn from the last fix
 * straight to the next one ignores the only positions there are.
 *
 * The track is the site's claim of where the balloon went, so a ghost
 * moves it only on these terms, all of them:
 *
 *  - A fix before it and a fix after it, each at least WAYPOINT_GAP_MS
 *    away. A ghost newer than the last fix never moves the track: it is
 *    the dashed tail and the beacon, as ever, until a fix comes back to
 *    judge it by.
 *  - Its square WAYPOINT_MIN_KM clear of the position before it on the
 *    line and of the fix after.
 *  - Inside the corridor those two fixes allow: the way round by the ghost
 *    no more than WAYPOINT_MAX_DETOUR times the straight way between them.
 *  - Every ghost of the silence, used or not, within reach of both fixes
 *    and of the ghost before it at the fastest a balloon is carried
 *    (lib/spoof.ts). One that is not means the GPS was lied to somewhere
 *    in that silence, there is no saying when it started, and the silence
 *    is drawn fix to fix as it always was.
 *  - No sign of GPS spoofing near the silence: no fix set aside as spoofed
 *    (`spoofed`) from SPOOF_SQUARE_WINDOW_MS before the fix that starts it
 *    to as long after the fix that ends it. A Regular message carries
 *    whatever square the GPS was told, and with spoofing about a square
 *    proves nothing.
 *
 * A ghost that fails any of these stays a ring beside the line. What a
 * false square can still do is bounded by the corridor: one that sits
 * between the two fixes, in a silence nothing else was heard in, cannot be
 * told from a true one by anything the tracker sends.
 *
 * All three lists oldest first. */
export function waypoints(
  track: TrackPoint[], ghosts: GhostPoint[], spoofed: { utc: string }[] = [],
): GhostPoint[] {
  const out: GhostPoint[] = [];
  const ms = (utc: string) => parseUtc(utc).getTime();
  const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
    haversineKm(a.lat, a.lon, b.lat, b.lon);
  const spoofMs = spoofed.map((p) => ms(p.utc));
  let g = 0;
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1]!;
    const b = track[i]!;
    const ta = ms(a.utc);
    const tb = ms(b.utc);
    if (tb - ta < 2 * WAYPOINT_GAP_MS) continue;
    while (g < ghosts.length && ghosts[g]!.utc <= a.utc) g++;
    if (spoofMs.some((t) => t >= ta - SPOOF_SQUARE_WINDOW_MS && t <= tb + SPOOF_SQUARE_WINDOW_MS)) {
      continue;
    }
    const direct = km(a, b);
    const taken: GhostPoint[] = [];
    let agree = true;
    // The ghost before the one in hand, whether or not it was taken: every
    // ghost of the silence is asked whether it can be true, not only the
    // ones the line would use.
    let seen: GhostPoint | undefined;
    for (let k = g; k < ghosts.length && ghosts[k]!.utc < b.utc; k++) {
      const w = ghosts[k]!;
      if (unreachable(a, w.utc, w.lat, w.lon, GRID4_SLACK_KM)
        || unreachable(b, w.utc, w.lat, w.lon, GRID4_SLACK_KM)
        || (seen && unreachable(seen, w.utc, w.lat, w.lon, 2 * GRID4_SLACK_KM))) {
        agree = false;
        break;
      }
      seen = w;
      const t = ms(w.utc);
      if (t - ta < WAYPOINT_GAP_MS || tb - t < WAYPOINT_GAP_MS) continue;
      if (km(a, w) + km(w, b) > WAYPOINT_MAX_DETOUR * direct) continue;
      if (km(taken.at(-1) ?? a, w) < WAYPOINT_MIN_KM || km(w, b) < WAYPOINT_MIN_KM) continue;
      taken.push(w);
    }
    if (agree) out.push(...taken);
  }
  return out;
}

/** For each waypoint, when the tracker was last heard in its square before
 * the next position on the line: the waypoint's own time, or that of a
 * later ghost in the same square. A waypoint stands for its square from
 * the first time the tracker was heard there, and a balloon in slack air
 * can be heard in one square for hours; anything that puts a time on the
 * line beyond it (lib/records.ts) has to start from when it was last
 * known to be there, not first. `way` is waypoints() of the same lists. */
export function heardUntil(
  track: TrackPoint[], ghosts: GhostPoint[], way: GhostPoint[],
): string[] {
  return way.map((w, i) => {
    const nextFix = track.find((p) => p.utc > w.utc)?.utc;
    const nextWay = way[i + 1]?.utc;
    const end = [nextFix, nextWay].filter((u): u is string => !!u).sort()[0];
    let until = w.utc;
    for (const g of ghosts) {
      if (g.utc <= until || (end && g.utc >= end)) continue;
      if (g.grid4 === w.grid4) until = g.utc;
    }
    return until;
  });
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
