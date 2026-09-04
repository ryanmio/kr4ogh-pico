/** Ground speed above what the telemetry field can hold.
 *
 * Basic Telemetry encodes speed in 42 values: 0 to 82 knots in 2-knot steps
 * (docs/telemetry-format.md). Traquito clamps rather than rolling over, so a
 * balloon in a 110-knot jet stream transmits 82 knots -- 94 mph -- and keeps
 * transmitting it for as long as the ride lasts. That number is not wrong,
 * it is a floor: "82 or faster". Read as a reading it flattens the fastest
 * part of every flight into a straight line.
 *
 * The track knows something the tracker could not say: where the balloon
 * actually was. Distance flown over a long enough baseline recovers the
 * speed the field could not carry.
 *
 * Only at the ceiling. Below it the tracker's own GPS speed is the better
 * measurement by a wide margin, and it is not close. A position here is a
 * grid subsquare centre, quantised to 4.6 km of latitude and 9.3 km of
 * longitude times cos(lat) -- about 2.5 km of positional uncertainty, so
 * 3.5 km between any two fixes, which over a single 10-minute leg is worth
 * some 11 knots of noise. Substituting that for a good GPS reading would
 * make the data worse. Where the field is blind it is the only measurement
 * there is.
 *
 * A window, not a leg, because that noise divides by the baseline: ~11 knots
 * of worst-case error over 10 minutes, ~6 over 40. The window grows
 * symmetrically so it stays
 * centred on the fix it describes, and it measures the path leg by leg
 * rather than the chord end to end -- summing legs follows a curving track
 * instead of cutting the corner, and the along-track errors telescope away
 * across it either way.
 *
 * This runs in the browser and at build time, never in the ingest: the
 * newest fix is the one people are watching, it arrives with no track after
 * it yet, and its estimate sharpens as the following fixes land. So the raw
 * field is what gets stored and this pass is re-run over the whole track
 * every time the track changes.
 */
import { haversineKm, parseUtc } from "./format";
import type { TrackPoint } from "./types";
import * as u from "./units";
import type { Units } from "./units";

/** Top of the speed field: index 41 of 42, at 2 knots a step. A fix
 * reporting this means "at least this", not "this". */
export const SPEED_CEILING_KT = 82;

/** Baseline the window aims for, and the only real accuracy dial here: the
 * quantisation noise is fixed, so the error falls as 1/baseline and nothing
 * else moves it. Measured against synthetic flights quantised through the
 * real grid6 encoding (dev/speed-check.ts), worst error over every bearing:
 *
 *     20 min  11.2 kt        50 min   5.2 kt
 *     30 min   8.9 kt        60 min   4.0 kt
 *     40 min   6.1 kt        80 min   3.0 kt
 *
 * 40 minutes is the knee. Lengthening it further buys progressively less
 * and costs at the live end of the track, where the window has no fixes
 * after it and a longer average lags the balloon by longer. A centred
 * window over a steadily changing speed has no bias either way, and float
 * speeds drift by a couple of knots an hour, so the lag is small -- but it
 * is the cost, and it is why this is not simply set to two hours. */
const MIN_BASELINE_MS = 40 * 60 * 1000;

/** Longest gap the window will step across. Reports come every 10 minutes
 * in sunlight, so this tolerates three missed slots. Past that the path
 * between two fixes is unknown, and a straight line drawn across an
 * overnight silence reads as a balloon that nearly stopped. */
const MAX_LEG_MS = 40 * 60 * 1000;

const KM_PER_NM = 1.852;

export function isSpeedSaturated(p: TrackPoint): boolean {
  return p.speed_kt >= SPEED_CEILING_KT;
}

/** The best ground speed known for a fix: the derived estimate where the
 * field saturated, the transmitted value everywhere else. Every reader of a
 * point's speed should go through here. */
export function groundSpeedKt(p: TrackPoint): number {
  return p.speed_kt_est ?? p.speed_kt;
}

/** True when the speed is only a lower bound -- the field saturated and the
 * track had no baseline to measure against, or measured slower than the
 * bound itself. The tracker's GPS saw at least 82 knots at that instant; a
 * window average spanning a slower stretch either side does not overrule
 * it, so the floor stands and the display says so. */
export function isSpeedFloor(p: TrackPoint): boolean {
  return p.speed_source === "floor";
}

export function hasSaturatedSpeed(track: TrackPoint[]): boolean {
  return track.some(isSpeedSaturated);
}

/** A fix's ground speed, formatted, marked with a trailing + when all that
 * is known is a floor. */
export function speedText(p: TrackPoint, units: Units): string {
  const m = u.speed(groundSpeedKt(p), units);
  return isSpeedFloor(p)
    ? `${m.value.toLocaleString("en-US")}+ ${m.unit}`
    : m.text;
}

/** Fill in `speed_kt_est` for every fix whose speed field saturated, from
 * the distance flown around it. Pure, and idempotent: it always derives
 * from `speed_kt` and the positions, never from a previous pass's estimate,
 * so re-running it after new fixes arrive simply produces better answers at
 * the end of the track. Returns the input array untouched when nothing
 * saturated, which is every flight that never found the jet stream. */
export function resolveTrackSpeeds(track: TrackPoint[]): TrackPoint[] {
  if (!hasSaturatedSpeed(track)) return track;
  const t = track.map((p) => parseUtc(p.utc).getTime());
  return track.map((p, i) => {
    if (!isSpeedSaturated(p)) return p;
    const derived = windowSpeedKt(track, t, i);
    return derived !== null && derived > SPEED_CEILING_KT
      ? { ...p, speed_kt_est: Math.round(derived * 10) / 10, speed_source: "derived" as const }
      : { ...p, speed_kt_est: SPEED_CEILING_KT, speed_source: "floor" as const };
  });
}

/** Ground speed measured from the track around one fix, whatever that
 * fix's own speed field says, or null when the track offers no usable
 * window. resolveTrackSpeeds only calls this at the ceiling; it is exported
 * so dev/speed-check.ts can call it everywhere else and hold the estimator
 * against the tracker's own GPS speed on a real flight. */
export function measuredSpeedKt(track: TrackPoint[], i: number): number | null {
  return windowSpeedKt(track, track.map((p) => parseUtc(p.utc).getTime()), i);
}

/** Mean ground speed over the smallest window around fix `i` that reaches
 * the baseline, or null when the track offers no usable one. */
function windowSpeedKt(
  track: TrackPoint[], t: number[], i: number,
): number | null {
  let a = i;
  let b = i;
  while (t[b]! - t[a]! < MIN_BASELINE_MS) {
    const canBack = a > 0 && t[a]! - t[a - 1]! <= MAX_LEG_MS;
    const canFwd = b < track.length - 1 && t[b + 1]! - t[b]! <= MAX_LEG_MS;
    if (!canBack && !canFwd) break;
    // Grow whichever side is currently shorter, so the window stays centred
    // on the fix wherever the track allows it. At the live end there is no
    // "after" to grow into and the window is purely trailing, which is the
    // honest answer for a balloon whose next report has not happened yet.
    if (canBack && (!canFwd || t[i]! - t[a]! <= t[b]! - t[i]!)) a--;
    else b++;
  }
  const elapsedMs = t[b]! - t[a]!;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  let km = 0;
  for (let j = a; j < b; j++) {
    km += haversineKm(track[j]!.lat, track[j]!.lon, track[j + 1]!.lat, track[j + 1]!.lon);
  }
  return km / KM_PER_NM / (elapsedMs / 3_600_000);
}
