/** When and where a sleeping balloon should be heard again.
 *
 * A solar-only tracker goes quiet when the sun gets low and comes back when
 * it is high enough again. How high is the tracker's own: its panels, its
 * firmware, the stations under it. So the cutoff is learned from the
 * flight itself, as the sun's elevation at the balloon when it was first
 * heard after each night, and the wake is where the existing forecast line
 * says the balloon will be when the sun climbs back through it. No requests
 * of its own: the track and the forecast are already on the page.
 */
import { parseUtc } from "./format";
import type { Forecast, ForecastPoint } from "./forecast";
import { unwrapNear } from "./ghosts";

const RAD = Math.PI / 180;

/** The sun's elevation in degrees above the horizon, at a place and time:
 * the low-precision almanac formula, good to a few hundredths of a degree,
 * which is far finer than a ten-minute slot can tell. */
export function sunElevation(ms: number, lat: number, lon: number): number {
  const d = ms / 86_400_000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const l = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const dec = Math.asin(Math.sin(e) * Math.sin(l));
  const ra = Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = (gmst * 15 + lon) * RAD - ra;
  return Math.asin(
    Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(ha),
  ) / RAD;
}

/** A silence counts as a night when it is this long, no longer than this,
 * and the sun was down at its middle. A long silence in daylight is an
 * ocean with nobody listening, and its end says nothing about the sun. */
const NIGHT_MIN_MS = 3 * 3_600_000;
const NIGHT_MAX_MS = 20 * 3_600_000;

/** Nights the flight must have woken from before its cutoff is trusted. */
const MIN_NIGHTS = 2;

type Heard = { utc: string; lat: number; lon: number };

/** The sun's elevation the balloon wakes at, learned from every night it
 * has come back from: the elevation at its first report after each.
 * Null before there are enough nights to say. Every report counts, a ghost
 * too: being heard at all is the tracker awake. */
export interface Cutoff {
  /** The median: when it is usually first heard. */
  typical: number;
  /** The lowest it has been heard at (never below the horizon, where a
   * solar tracker cannot be running and a report can only be a stray).
   * A first report is only as early as the stations under the balloon
   * allow, so it shows the tracker was awake by then, not that it woke
   * then; the lowest is the nearest any of them comes to when it wakes.
   * It decides the days a balloon can wake on: in a high-latitude winter
   * the sun can peak short of the median and still clear this. */
  lowest: number;
}

export function wakeCutoff(reports: Heard[]): Cutoff | null {
  const heard = [...reports].sort((a, b) => a.utc.localeCompare(b.utc));
  const wakes: number[] = [];
  for (let i = 1; i < heard.length; i++) {
    const a = heard[i - 1]!;
    const b = heard[i]!;
    const ta = parseUtc(a.utc).getTime();
    const tb = parseUtc(b.utc).getTime();
    const gap = tb - ta;
    if (gap < NIGHT_MIN_MS || gap > NIGHT_MAX_MS) continue;
    const midLon = (a.lon + unwrapNear(b.lon, a.lon)) / 2;
    if (sunElevation((ta + tb) / 2, (a.lat + b.lat) / 2, midLon) >= 0) continue;
    wakes.push(sunElevation(tb, b.lat, b.lon));
  }
  if (wakes.length < MIN_NIGHTS) return null;
  wakes.sort((x, y) => x - y);
  const m = wakes.length >> 1;
  const typical = wakes.length % 2 ? wakes[m]! : (wakes[m - 1]! + wakes[m]!) / 2;
  return { typical, lowest: Math.min(typical, ...wakes.filter((e) => e >= 0)) };
}

/** How long the balloon must have been unheard before a wake is shown:
 * two missed slots, so a balloon still talking in the dusk has no "back at"
 * hung on it. */
const SILENT_MS = 20 * 60_000;

export interface Wake {
  /** Where and when, on the forecast line. */
  point: ForecastPoint;
  /** The forecast point the wake falls after, so a renderer can place it
   * beside the line it has already unwrapped. */
  index: number;
  /** The sun elevation it was placed at, in degrees. */
  cutoff: number;
}

/** Where along the forecast the balloon wakes. Null unless it is asleep:
 * unheard for a while, and with the sun below its usual wake elevation
 * where the line has it now. A balloon unheard in full sun is over an empty
 * ocean, not asleep, and tomorrow's sunrise would be the wrong answer.
 *
 * Each stretch of the line with the sun at or above the lowest elevation
 * the balloon has woken at is a day it can wake on, and it wakes on the
 * first one still ahead: where the sun climbs through its usual elevation,
 * or, on a day the sun never gets that high, at that day's highest sun.
 * Without the second case a balloon drifting north in winter, under a
 * noon sun a few degrees short of the median, would be shown sleeping
 * through a day it can wake on, and its wake put a full day late. */
export function expectedWake(
  f: Forecast, cutoff: Cutoff, lastHeardUtc: string, now: number = Date.now(),
): Wake | null {
  if (now - parseUtc(lastHeardUtc).getTime() < SILENT_MS) return null;
  const { typical, lowest } = cutoff;
  const pts = f.points;
  const n = pts.length;
  const t = pts.map((p) => parseUtc(p.utc).getTime());
  const el = pts.map((p, i) => sunElevation(t[i]!, p.lat, p.lon));
  // The line's point nearest now says where the sun is for the balloon.
  let at = t.findIndex((x) => x >= now);
  if (at < 0) return null;
  if (at > 0 && now - t[at - 1]! < t[at]! - now) at -= 1;
  if (el[at]! >= typical) return null;
  let i = at;
  while (i < n) {
    if (el[i]! < lowest) { i++; continue; }
    const start = i;
    let peak = i;
    for (; i < n && el[i]! >= lowest; i++) if (el[i]! > el[peak]!) peak = i;
    for (let j = Math.max(1, start); j < i; j++) {
      if (el[j - 1]! < typical && el[j]! >= typical) {
        const a = pts[j - 1]!;
        const b = pts[j]!;
        const k = (typical - el[j - 1]!) / (el[j]! - el[j - 1]!);
        const ms = t[j - 1]! + k * (t[j]! - t[j - 1]!);
        const lon = a.lon + k * (unwrapNear(b.lon, a.lon) - a.lon);
        return {
          point: {
            utc: new Date(ms).toISOString().slice(0, 19).replace("T", " "),
            lat: a.lat + k * (b.lat - a.lat),
            lon: unwrapNear(lon, 0),
            altitude_m: a.altitude_m + k * (b.altitude_m - a.altitude_m),
          },
          index: j - 1,
          cutoff: typical,
        };
      }
    }
    // A day the sun stays under the usual elevation. One the line runs out
    // in may yet climb past it; one already past its peak is today's
    // afternoon, gone.
    if (i === n) return null;
    if (peak > at) return { point: pts[peak]!, index: peak, cutoff: el[peak]! };
  }
  return null;
}
