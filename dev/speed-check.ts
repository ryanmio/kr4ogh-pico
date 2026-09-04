/** Check the derived-speed pass in lib/speed.ts.
 *
 * The telemetry speed field saturates at 82 knots, so above that the site
 * measures speed from the distance flown instead. There is no ground truth
 * to compare against -- the whole point is that the tracker could not tell
 * us -- so this measures the estimator two ways.
 *
 * 1. Synthetic: fly a balloon at a known speed on a great circle, quantise
 *    every position to its grid6 subsquare centre exactly as the wire format
 *    does, and check the recovered speed against the speed flown. That is
 *    the accuracy claim, tested end to end through the same quantisation the
 *    real data suffers.
 * 2. Real: run the committed F1B track through and check the invariants --
 *    unsaturated fixes untouched, saturated fixes never below the floor, the
 *    pass idempotent.
 *
 * Run:  npx tsx dev/speed-check.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { haversineKm } from "../src/lib/format";
import {
  groundSpeedKt, isSpeedFloor, measuredSpeedKt, resolveTrackSpeeds,
  SPEED_CEILING_KT,
} from "../src/lib/speed";
import { maidenheadToLatLon } from "../src/lib/wspr/decode";
import type { TrackPoint } from "../src/lib/types";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;

/** The inverse of decode.ts's maidenheadToLatLon: a true position to the
 * grid6 square containing it. Only the test needs this direction -- the
 * tracker does it on the balloon -- but the test needs it to be exactly the
 * same quantisation the wire format applies. */
function latLonToGrid6(lat: number, lon: number): string {
  const x = lon + 180;
  const y = lat + 90;
  return String.fromCharCode(65 + Math.floor(x / 20))
    + String.fromCharCode(65 + Math.floor(y / 10))
    + Math.floor((x % 20) / 2)
    + Math.floor(y % 10)
    + String.fromCharCode(97 + Math.floor((x % 2) / (5 / 60)))
    + String.fromCharCode(97 + Math.floor((y % 1) / (2.5 / 60)));
}

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---------- 1. synthetic flight at a known speed ----------

const KM_PER_NM = 1.852;

/** A fix every `stepMin` minutes on a rhumb-ish great circle from a start
 * point on a fixed bearing, positions quantised to grid6 like the wire
 * format does, speeds clamped to the field ceiling like the tracker does. */
function syntheticTrack(
  speedKt: number, bearingDeg: number, count: number, stepMin = 10,
  startLat = 37, startLon = -60,
): TrackPoint[] {
  const rad = Math.PI / 180;
  const R = 6371;
  const d = (speedKt * KM_PER_NM * stepMin) / 60 / R; // angular distance/leg
  const brg = bearingDeg * rad;
  let lat = startLat * rad;
  let lon = startLon * rad;
  const out: TrackPoint[] = [];
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      const lat2 = Math.asin(
        Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(brg));
      lon += Math.atan2(
        Math.sin(brg) * Math.sin(d) * Math.cos(lat),
        Math.cos(d) - Math.sin(lat) * Math.sin(lat2));
      lat = lat2;
    }
    // Through the real quantisation: true position -> grid6 -> subsquare
    // centre, which is all a receiver ever learns.
    const grid6 = latLonToGrid6(lat / rad, lon / rad);
    const [qlat, qlon] = maidenheadToLatLon(grid6);
    out.push({
      utc: new Date(Date.UTC(2026, 8, 1, 0, i * stepMin))
        .toISOString().slice(0, 19).replace("T", " "),
      grid6, lat: qlat, lon: qlon,
      altitude_m: 10680,
      // The tracker clamps, and rounds down to the 2-knot step.
      speed_kt: Math.min(SPEED_CEILING_KT, Math.floor(speedKt / 2) * 2),
      voltage_v: 3.8, temperature_c: -15, gps_valid: true, rx_station_count: 30,
    });
  }
  return out;
}

/** Worst absolute error over the saturated fixes of a synthetic flight. */
function worstErrorKt(speedKt: number, bearingDeg: number): number {
  const resolved = resolveTrackSpeeds(syntheticTrack(speedKt, bearingDeg, 24));
  let worst = 0;
  for (const p of resolved) {
    if (p.speed_kt < SPEED_CEILING_KT) continue;
    worst = Math.max(worst, Math.abs(groundSpeedKt(p) - speedKt));
  }
  return worst;
}

// Every bearing, because the longitude subsquare is twice the latitude one
// and an east-west flight is quantised very differently from a north-south.
const bearings = [0, 30, 45, 60, 90, 120, 135, 150, 180, 225, 270, 315];
for (const trueKt of [95, 110, 140]) {
  let worst = 0;
  let worstBrg = 0;
  for (const b of bearings) {
    const e = worstErrorKt(trueKt, b);
    if (e > worst) { worst = e; worstBrg = b; }
  }
  // The budget is the quantisation limit, not a preference: the worst a
  // 40-minute baseline can do is half a subsquare diagonal at each end over
  // 40 minutes, which is about 6.5 knots. Failing this means the estimator
  // stopped being as good as the data allows.
  check(`synthetic ${trueKt} kt: worst error over all bearings`,
    worst <= 6.5, `${worst.toFixed(1)} kt at ${worstBrg}\u00b0 (limit 6.5)`);
}

// A flight that never saturates must come back byte-identical.
const slow = syntheticTrack(40, 90, 12);
check("unsaturated track is returned untouched",
  resolveTrackSpeeds(slow) === slow);

// One fix alone, or fixes separated by an overnight silence, have no
// baseline to measure against and must fall back to the floor rather than
// invent a number from a chord across the gap.
const lone = syntheticTrack(110, 90, 1);
check("a single saturated fix falls back to the floor",
  isSpeedFloor(resolveTrackSpeeds(lone)[0]!)
  && groundSpeedKt(resolveTrackSpeeds(lone)[0]!) === SPEED_CEILING_KT);

const split = syntheticTrack(110, 90, 2, 8 * 60); // 8 hours apart
check("a fix across an 8-hour silence falls back to the floor",
  resolveTrackSpeeds(split).every(isSpeedFloor));

// ---------- 2. the committed F1B track ----------

const track: TrackPoint[] = JSON.parse(
  readFileSync(process.argv[2] ?? join(here, "../src/data/tracks/KR4OGH-F1B.json"), "utf8"));
const resolved = resolveTrackSpeeds(track);
const saturated = resolved.filter((p) => p.speed_kt >= SPEED_CEILING_KT);

check("F1B: unsaturated fixes are left exactly as transmitted",
  resolved.every((p, i) =>
    p.speed_kt >= SPEED_CEILING_KT
    || (p.speed_kt_est === undefined && p === track[i])));
check("F1B: no saturated fix reads below the floor the tracker proved",
  saturated.every((p) => groundSpeedKt(p) >= SPEED_CEILING_KT));
check("F1B: the pass is idempotent",
  JSON.stringify(resolveTrackSpeeds(resolved)) === JSON.stringify(resolved));
console.log(`      F1B: ${saturated.length} of ${track.length} fixes at the ceiling`);

// ---------- 3. the estimator against real GPS ----------
//
// F1B never reached the ceiling, which makes it the ideal witness: every
// fix carries the tracker's own GPS ground speed, so the window estimator
// can be run over the same positions and held against the truth it would
// have had to replace. Real receiver-reported grids, real gaps, real
// weather. The comparison is not exact even in principle -- the tracker
// reports an instant, quantised to 2 knots, and this reports a 40-minute
// mean -- so a few knots of disagreement is the flight changing speed, not
// the estimator being wrong.
let sumSq = 0;
let worstReal = 0;
let worstAt = "";
let compared = 0;
for (let i = 0; i < track.length; i++) {
  const measured = measuredSpeedKt(track, i);
  if (measured === null) continue;
  const err = measured - track[i]!.speed_kt;
  sumSq += err * err;
  if (Math.abs(err) > Math.abs(worstReal)) { worstReal = err; worstAt = track[i]!.utc; }
  compared++;
}
const rms = Math.sqrt(sumSq / compared);
check("F1B: measured speed tracks the tracker's own GPS speed",
  rms <= 6 && Math.abs(worstReal) <= 20,
  `rms ${rms.toFixed(2)} kt over ${compared} fixes, worst ` +
  `${worstReal > 0 ? "+" : ""}${worstReal.toFixed(1)} at ${worstAt}`);

// Distance flown is the same measurement the estimator makes, so if the two
// disagreed on a whole flight one of them would be wrong.
const hours = (Date.parse(`${track.at(-1)!.utc}Z`.replace(" ", "T"))
  - Date.parse(`${track[0]!.utc}Z`.replace(" ", "T"))) / 3_600_000;
let totalKm = 0;
for (let i = 1; i < track.length; i++) {
  totalKm += haversineKm(track[i - 1]!.lat, track[i - 1]!.lon, track[i]!.lat, track[i]!.lon);
}
console.log(`      F1B: ${totalKm.toFixed(0)} km in ${hours.toFixed(1)} h `
  + `= ${(totalKm / KM_PER_NM / hours).toFixed(1)} kt whole-flight mean `
  + `(silences included, so below the flying speed)`);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
