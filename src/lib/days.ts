/** A flight's days, so a long flight can be read one at a time.
 *
 * After two weeks aloft a chart gives each day a few millimetres, and the
 * map is a line across an ocean. Picking a day (or a few) redraws both
 * around it: the chart at that day's own scale, the map on that stretch of
 * the track.
 *
 * A "day" here is the balloon's, not the calendar's: one stretch of
 * daylight, counted from launch. A solar tracker reports from sunrise to
 * sunset where it is, and where it is drifts round the world, so its days
 * line up with nobody's dates. Over the Pacific one daylight straddles UTC
 * midnight; on a lap of the globe eastwards the balloon sees one more
 * sunrise than the calendar has dates. So each fix is given the solar time
 * at its own longitude (UTC plus four minutes a degree, the longitude
 * unwrapped so a lap adds a day rather than jumping back one), and the day
 * turns over at solar midnight, which is the one hour a solar tracker is
 * sure to be silent. Day 1 is the launch's.
 *
 * That number is what a link carries: `?d=11`, `?d=10-12`. It means the
 * same fixes to every reader, whatever their time zone, and it does not
 * move as the flight goes on. The dates on screen ("Nov 21") are the
 * reader's own, like every other time on the page.
 */

import { unwrapLons } from "./basemap";
import { fmtLocalDay, parseUtc } from "./format";

/** Flight days, first to last inclusive, numbered from 1 at launch. */
export interface DaySpan { from: number; to: number }

type Fix = { utc: string; lon: number };

const DAY_MS = 86_400_000;
const MS_PER_DEG = DAY_MS / 360;

/** The flight day of every fix, in track order: never decreasing. */
export function flightDays(track: Fix[]): number[] {
  if (!track.length) return [];
  const lons = unwrapLons(track);
  const solar = track.map((p, i) => parseUtc(p.utc).getTime() + lons[i]! * MS_PER_DEG);
  const first = Math.floor(solar[0]! / DAY_MS);
  return solar.map((s) => Math.floor(s / DAY_MS) - first + 1);
}

/** Fewest fixes worth showing on their own: three is the least that
 * gives every chart a line, the Signal panel's included, which draws the
 * gaps between fixes and so has one point fewer. */
const MIN_FIXES = 3;

/** The days there is something to show of, in order. */
export function daysWithData(days: number[]): number[] {
  const out: number[] = [];
  for (let i = MIN_FIXES - 1; i < days.length; i++) {
    if (days[i] === days[i - MIN_FIXES + 1] && out[out.length - 1] !== days[i]) {
      out.push(days[i]!);
    }
  }
  return out;
}

/** The fixes a span covers, as first and last index into the track; null
 * when it covers too few to show (MIN_FIXES): a link to a day the flight
 * never had, or has not reached yet. */
export function spanIndexes(days: number[], span: DaySpan): [number, number] | null {
  const a = days.findIndex((d) => d >= span.from);
  if (a < 0) return null;
  let b = days.length - 1;
  while (b >= a && days[b]! > span.to) b--;
  return b - a >= MIN_FIXES - 1 ? [a, b] : null;
}

/** The dates a span covers, in the reader's time zone: "Nov 21",
 * "Nov 20–22", "Nov 28 – Dec 2". Each end is named for the middle of its
 * daylight, as the chart's own axis names a day.
 *
 * A balloon on the far side of the world from the reader has its daylight
 * across the reader's midnight, and then two of its days in a row can
 * fall on one of the reader's dates. A single day that shares its date
 * with a neighbour says which it is: "Nov 15 early", "Nov 15 late". */
export function spanLabel(track: Fix[], days: number[], span: DaySpan): string {
  const at = spanIndexes(days, span);
  if (!at) return "";
  const dateOf = (day: number | undefined) => {
    if (day === undefined) return "";
    const a = days.indexOf(day);
    const b = days.lastIndexOf(day);
    return fmtLocalDay(new Date(
      (parseUtc(track[a]!.utc).getTime() + parseUtc(track[b]!.utc).getTime()) / 2));
  };
  const first = dateOf(days[at[0]]!);
  const last = dateOf(days[at[1]]!);
  if (days[at[0]] === days[at[1]]) {
    const avail = daysWithData(days);
    const i = avail.indexOf(days[at[0]]!);
    if (dateOf(avail[i - 1]) === first) return `${first} late`;
    if (dateOf(avail[i + 1]) === first) return `${first} early`;
    return first;
  }
  if (first === last) return first;
  const [m1, d1] = first.split(" ");
  const [m2, d2] = last.split(" ");
  return m1 === m2 ? `${m1} ${d1}\u2013${d2}` : `${first} \u2013 ${last}`;
}

/** The span one step earlier (-1) or later (+1): the same number of days,
 * moved along by its own length, and on past any stretch with nothing in
 * it (a silence of days). Null at either end of the flight. */
export function stepSpan(span: DaySpan, dir: 1 | -1, avail: number[]): DaySpan | null {
  if (!avail.length) return null;
  const width = span.to - span.from + 1;
  const lo = avail[0]!;
  const hi = avail[avail.length - 1]!;
  for (let k = 1; ; k++) {
    const next = { from: span.from + dir * width * k, to: span.to + dir * width * k };
    if (next.to < lo || next.from > hi) return null;
    if (avail.some((d) => d >= next.from && d <= next.to)) return next;
  }
}

/** The query parameter that picks the days: `?d=11`, `?d=10-12`. */
export const URL_PARAM = "d";

/** Read the days out of a query string; null for none, and for anything
 * that is not a day or a run of them. Whether the flight has those days
 * is the caller's to check (spanIndexes), once it has the track. */
export function daysFromSearch(search: string): DaySpan | null {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get(URL_PARAM);
  } catch {
    return null;
  }
  const m = raw?.trim().match(/^(\d{1,4})(?:-(\d{1,4}))?$/);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  return from >= 1 && to >= from ? { from, to } : null;
}

/** The same page with the days pinned, or taken back out for the whole
 * flight. Every other parameter and the hash are kept. */
export function urlWithDays(href: string, span: DaySpan | null): string {
  const url = new URL(href);
  if (span === null) url.searchParams.delete(URL_PARAM);
  else {
    url.searchParams.set(URL_PARAM,
      span.from === span.to ? `${span.from}` : `${span.from}-${span.to}`);
  }
  return url.toString();
}
