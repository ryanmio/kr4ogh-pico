/** The sun as the balloon sees it.
 *
 * The tracker never measures the sun; it does not have to. A report says
 * where the balloon was and when, and the sun's place in the sky follows
 * from those two alone. For a tracker that runs on sunlight and nothing
 * else it is the number behind most of the others: the voltage, the
 * temperature, and whether there is a report at all.
 */
import { parseUtc } from "./format";

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

type Report = { utc: string; lat: number; lon: number };

/** The sun's elevation at a report: where the balloon was, when it said so. */
export function sunAt(p: Report): number {
  return sunElevation(parseUtc(p.utc).getTime(), p.lat, p.lon);
}

/** The reading a card leads with. A flight still up is asked where the sun
 * is this minute, over the place it was last heard: the sun keeps moving
 * while the tracker sleeps, and "8 degrees", true at dusk, would be wrong
 * all night. The balloon drifts on in that silence, an hour of sun at the
 * very most by morning, which matters to nobody reading "40 below". A
 * flight that is over has no now, and is read at its last report. */
export function sunReading(last: Report, live: boolean, now: number = Date.now()): number {
  return live ? sunElevation(now, last.lat, last.lon) : sunAt(last);
}

/** Whole degrees, with a real minus sign for a sun under the horizon. */
export function fmtSun(deg: number): string {
  const r = Math.round(deg);
  return `${r < 0 ? "−" : ""}${Math.abs(r)}°`;
}
