/** Fixes whose GPS was lied to.
 *
 * Over parts of the Middle East and around conflict zones the GPS signal is
 * spoofed: a transmitter on the ground broadcasts fake satellite signals and
 * the tracker's receiver locks onto them. The tracker then honestly reports
 * a position, altitude and speed that are not the balloon's -- typically
 * the spoofer's own spot on the ground, at a few hundred metres and 0
 * knots, hundreds of kilometres from where the balloon actually is. The
 * telemetry is otherwise fine: the voltage, the temperatures, the pressure
 * are all measured on board and owe nothing to GPS.
 *
 * Such a fix is dropped from the track, not drawn: on the map it is a
 * spike to a place the balloon never went, and every number built on the
 * track -- distance flown, highest, fastest, the forecast's starting point
 * -- would inherit it. What is kept is the fact that the tracker was heard,
 * so "last heard" and time aloft stay true while the spoofing goes on.
 *
 * Two tests, either of which condemns a fix:
 *
 *  - The pressure sensor disagrees. A Petrel tracker's BME280 measures the
 *    air around it, which no spoofer can fake. Pressure altitude and GPS
 *    altitude normally agree within a few hundred metres (PT01: -785 m on
 *    the launch pad to +611 m at float, the gap being the real atmosphere's
 *    departure from the standard one). A spoofed fix on the ground under a
 *    balloon at float is off by ten kilometres.
 *
 *  - The position is unreachable. Measured from the last fix that passed,
 *    the balloon would have had to fly faster than any jet stream carries
 *    one. This is the only test a stock tracker gets, and the one that
 *    catches a spoofer whose fake altitude happens to be plausible.
 *
 * Like lib/speed.ts this is a derived pass over the whole track, re-run
 * whenever the track changes, and never applied to what is stored: the
 * committed track and /live/<id>/track.json keep every fix the tracker
 * sent.
 */
import { haversineKm, parseUtc } from "./format";
import { resolveTrackSpeeds } from "./speed";
import type { GhostPoint, TrackPoint } from "./types";

/** Pressure and GPS altitude further apart than this condemn a fix. Nearly
 * four times the widest gap an honest PT01 fix has shown, and under a third
 * of the gap a spoof to the ground under a balloon at float opens. */
export const MAX_ALTITUDE_GAP_M = 3000;

/** Faster than any balloon has been carried: the strongest jet stream
 * cores run near 200 knots. */
const MAX_GROUND_SPEED_KT = 300;

/** Room for where a position can sit inside its grid square, at both ends
 * of the leg: a grid6 subsquare is under 10 km across, a grid4 square
 * about 110 by 220 km. */
const GRID6_SLACK_KM = 15;
const GRID4_SLACK_KM = 140;

/** A ghost reporting a square that a spoofed fix reported within this long
 * is taken to be spoofed too: the Regular message carries the same faked
 * square as the fix, and a spoofer tends to hold one place for hours. */
const SPOOF_SQUARE_WINDOW_MS = 6 * 3600 * 1000;

const KM_PER_NM = 1.852;

/** Altitude in the standard atmosphere for a static pressure, metres. Good
 * to a few hundred metres anywhere a balloon flies, which is all the test
 * above needs. */
export function pressureAltitudeM(hpa: number): number {
  return 44330.8 * (1 - Math.pow(hpa / 1013.25, 0.190263));
}

/** True when the fix carries a pressure reading that puts it somewhere
 * else in the sky than its GPS does. */
export function pressureDisagrees(p: TrackPoint): boolean {
  if (p.pressure_hpa == null || !(p.pressure_hpa > 0)) return false;
  return Math.abs(pressureAltitudeM(p.pressure_hpa) - p.altitude_m) > MAX_ALTITUDE_GAP_M;
}

/** True when getting from `from` to (lat, lon) by `utc` would have taken
 * more than the fastest wind there is. */
function unreachable(
  from: TrackPoint, utc: string, lat: number, lon: number, slackKm: number,
): boolean {
  const hours = Math.abs(parseUtc(utc).getTime() - parseUtc(from.utc).getTime()) / 3_600_000;
  const km = haversineKm(from.lat, from.lon, lat, lon);
  return km > MAX_GROUND_SPEED_KT * KM_PER_NM * hours + slackKm;
}

export interface SpoofSplit {
  /** The fixes that passed, oldest first: the track. */
  track: TrackPoint[];
  /** The fixes condemned, oldest first. Heard, so they count toward when
   * the tracker was last heard; nothing else. */
  spoofed: TrackPoint[];
}

/** Split a track, oldest first, into the fixes to believe and the ones
 * whose GPS was spoofed. Each fix is measured against the last one that
 * passed, so a spoof lasting hours is caught end to end and the first true
 * fix after it is measured against the last true one before. Returns the
 * input array itself when nothing is condemned. */
export function splitSpoofed(track: TrackPoint[]): SpoofSplit {
  const kept: TrackPoint[] = [];
  const spoofed: TrackPoint[] = [];
  for (const p of track) {
    const anchor = kept.at(-1);
    if (pressureDisagrees(p)
      || (anchor && unreachable(anchor, p.utc, p.lat, p.lon, GRID6_SLACK_KM))) {
      spoofed.push(p);
    } else {
      kept.push(p);
    }
  }
  return { track: spoofed.length ? kept : track, spoofed };
}

/** Drop the ghosts whose square was spoofed too. A ghost has no altitude to
 * check, only its grid square, so it goes when that square is one a
 * spoofed fix reported around the same time, or when it is out of reach of
 * the believed fix before it (after it, for a ghost older than the whole
 * track). Returns the input array itself when nothing is dropped. */
export function dropSpoofedGhosts(
  track: TrackPoint[], spoofed: TrackPoint[], ghosts: GhostPoint[],
): GhostPoint[] {
  if (!ghosts.length || (!spoofed.length && track.length < 2)) return ghosts;
  const spoofedAt = spoofed.map((p) => ({
    t: parseUtc(p.utc).getTime(), grid4: p.grid6.slice(0, 4).toUpperCase(),
  }));
  const out = ghosts.filter((g) => {
    const t = parseUtc(g.utc).getTime();
    if (spoofedAt.some((s) => s.grid4 === g.grid4 && Math.abs(s.t - t) <= SPOOF_SQUARE_WINDOW_MS)) {
      return false;
    }
    let anchor: TrackPoint | undefined;
    for (const p of track) {
      if (p.utc > g.utc) break;
      anchor = p;
    }
    anchor ??= track[0];
    return !anchor || !unreachable(anchor, g.utc, g.lat, g.lon, GRID4_SLACK_KM);
  });
  return out.length === ghosts.length ? ghosts : out;
}

/** A flight as the site shows it, from the track and ghosts as decoded. */
export interface Believed {
  /** The fixes to believe, with speeds above the telemetry ceiling filled
   * in (lib/speed.ts). */
  track: TrackPoint[];
  ghosts: GhostPoint[];
  /** The fixes dropped as spoofed, as decoded. */
  spoofed: TrackPoint[];
}

/** The one pass every track goes through on its way to the page, at build
 * time and after every live refresh: spoofed fixes out, and their ghosts
 * with them, then the speeds. In that order, because a speed measured
 * across a spoofed fix measures the jump to the spoofer and back. */
export function believe(raw: TrackPoint[], rawGhosts: GhostPoint[]): Believed {
  const { track, spoofed } = splitSpoofed(raw);
  return {
    track: resolveTrackSpeeds(track),
    ghosts: dropSpoofedGhosts(track, spoofed, rawGhosts),
    spoofed,
  };
}

/** The first fix of a spoof still going on: the run of spoofed fixes newer
 * than anything believed, track or ghost. Null when the newest report is
 * one to believe, which is every flight that has not met a spoofer. The
 * position the site shows is then from before this, and it says so. */
export function spoofedSince(
  track: TrackPoint[], ghosts: GhostPoint[], spoofed: TrackPoint[],
): TrackPoint | null {
  const believed = [track.at(-1)?.utc ?? "", ghosts.at(-1)?.utc ?? ""].sort().at(-1)!;
  return spoofed.find((p) => p.utc > believed) ?? null;
}

/** One spoof, as the map draws it with `?spoofing=show`: the spoofed fixes
 * in a row, and the true fixes either side, which are where the GPS jumped
 * from and back to. Indices into the believed track; null at an end the
 * track does not reach, such as a spoof still going on. */
export interface SpoofRun {
  before: number | null;
  fixes: TrackPoint[];
  after: number | null;
}

/** Group spoofed fixes into the runs between believed ones. */
export function spoofRuns(track: TrackPoint[], spoofed: TrackPoint[]): SpoofRun[] {
  const runs: SpoofRun[] = [];
  let i = 0; // the first believed fix newer than the one being placed
  for (const p of spoofed) {
    while (i < track.length && track[i]!.utc < p.utc) i++;
    const before = i > 0 ? i - 1 : null;
    const last = runs.at(-1);
    if (last && last.before === before) last.fixes.push(p);
    else runs.push({ before, fixes: [p], after: i < track.length ? i : null });
  }
  return runs;
}

/** The query parameter that draws the spoofed fixes on the map, where the
 * GPS said they were: `?spoofing=show`. A link-only view, never
 * remembered: the reader who follows a link about a spoof gets it, and the
 * map everyone else sees stays the balloon's true path. */
export const SPOOF_URL_PARAM = "spoofing";

const SHOW = new Set(["show", "view", "on", "1", "true", "yes"]);

export function spoofViewFromSearch(search: string): boolean {
  try {
    const raw = new URLSearchParams(search).get(SPOOF_URL_PARAM);
    return raw !== null && SHOW.has(raw.trim().toLowerCase());
  } catch {
    return false;
  }
}

/** The same page with the spoofed fixes shown or not, every other
 * parameter and the hash kept. */
export function urlWithSpoofView(href: string, show: boolean): string {
  const url = new URL(href);
  if (show) url.searchParams.set(SPOOF_URL_PARAM, "show");
  else url.searchParams.delete(SPOOF_URL_PARAM);
  return url.toString();
}
