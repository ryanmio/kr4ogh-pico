/** The second pairing tier: telemetry heard by a different station.
 *
 * A direct port of tool/picolog/infer.py; dev/verify-port.ts holds the two
 * to the same output. The confirmed tier (match.ts) needs one station to
 * hear both our Regular message and the telemetry. Where receivers are
 * sparse, one station hears the Regular and another the telemetry, and the
 * confirmed tier links nothing. This accepts such a message, as "inferred",
 * only when all of these hold (docs/cross-receiver-pairing.md):
 *
 *  1. It was sent in the right minute, and some station reported it inside
 *     the channel's lane.
 *  2. It decodes as ours: basic telemetry with GPS valid, or the Petrel
 *     sensor message (extended header 0/0/0, slot 3) with the sensor
 *     answering.
 *  3. There is a grid square for it: our Regular in the same cycle from any
 *     station, or else the nearest Regulars before and after, within half
 *     an hour each, reporting the same square.
 *  4. It is physically plausible: reachable from the last believed fix at
 *     1.5x the larger of its speed and 100 kt, within 1,500 m of the last
 *     believed confirmed fix's altitude, and reachable from and to the
 *     Regular squares either side.
 *  5. It is the only message in its slot that passes all of that.
 */
import type { Channel } from "./channels";
import { slotMinute } from "./channels";
import {
  BME280_SLOT, DecodeError, decodeBme280Slot3, decodeCallsign, decodeGridPower,
  maidenheadToLatLon, sensorFailed,
} from "./decode";
import type { Spot } from "./query";

export const INFER_NAME = "cross-receiver";
export const INFER_VERSION = 1;

export const LANE_BELOW_HZ = 10;
export const LANE_ABOVE_HZ = 35;
const NEIGHBOUR_WINDOW_MS = 30 * 60 * 1000;
const SPEED_FACTOR = 1.5;
const SPEED_FLOOR_KT = 100;
export const MAX_FLOAT_DEPARTURE_M = 1500;
const GRID6_SLACK_KM = 15;
const GRID4_SLACK_KM = 140;
const SPOOF_ALTITUDE_GAP_M = 3000;
const SPOOF_MAX_SPEED_KT = 300;
const KM_PER_NM = 1.852;
const EARTH_RADIUS_KM = 6371;

/** A fix as the inferred tier reads one: where, when, how high, and
 * whether it was itself inferred (then it never defines float). */
export interface KnownFix {
  utc: string; // "YYYY-MM-DD HH:MM:SS"
  lat: number;
  lon: number;
  altitude_m: number;
  pressure_hpa?: number | null;
  tier?: "confirmed" | "inferred";
}

export interface Decision {
  cycleUtc: string;
  kind: "basic" | "sensor";
  outcome: "inferred" | "ambiguous" | "rejected" | "unplaced";
  reason: string;
}

export interface InferredFix {
  utc: string;
  grid6: string;
  lat: number;
  lon: number;
  altitude_m: number;
  speed_kt: number;
  voltage_v: number;
  temperature_c: number;
  gps_valid: boolean;
  rx_station_count: number;
  tier: "inferred";
  pairing: string;
}

export interface InferredSensor {
  pressure_hpa: number;
  board_temp_c: number;
  humidity_pct: number;
  sensor_tier: "inferred";
  sensor_pairing: string;
  grid4: string;
  rx_station_count: number;
}

export interface Inferred {
  fixes: InferredFix[];
  sensors: Map<string, InferredSensor>;
  decisions: Decision[];
}

const ms = (s: string) => Date.parse(s.slice(0, 19).replace(" ", "T") + "Z");
const fmt = (t: number) => new Date(t).toISOString().slice(0, 19).replace("T", " ");

/** The Regular slot a message's cycle starts at. */
export function cycleOf(time: string, startMinute: number): string {
  const minute = Number(time.slice(14, 16));
  const back = (((minute - startMinute) % 10) + 10) % 10;
  return fmt(ms(time) - back * 60_000);
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

function pressureAltitudeM(hpa: number): number {
  return 44330.8 * (1 - Math.pow(hpa / 1013.25, 0.190263));
}

export function inLane(frequency: number, ch: Channel): boolean {
  const f = Number(frequency);
  return ch.frequencyHz - LANE_BELOW_HZ <= f && f <= ch.frequencyHz + LANE_ABOVE_HZ;
}

const hours = (a: string, b: string) => Math.abs(ms(a) - ms(b)) / 3_600_000;
const reachKm = (h: number, kt: number) =>
  SPEED_FACTOR * Math.max(kt, SPEED_FLOOR_KT) * KM_PER_NM * h;

/** Python's f"{x:.0f}": round half to even. */
function f0(x: number): string {
  const r = Math.round(x);
  return String(Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r);
}

/** The site's spoof rule (lib/spoof.ts): false for a fix it sets aside. */
function believable(fix: KnownFix, anchor: KnownFix | null): boolean {
  const p = fix.pressure_hpa;
  if (p != null && p > 0
    && Math.abs(pressureAltitudeM(p) - fix.altitude_m) > SPOOF_ALTITUDE_GAP_M) return false;
  if (!anchor) return true;
  const km = haversineKm(anchor.lat, anchor.lon, fix.lat, fix.lon);
  return km <= SPOOF_MAX_SPEED_KT * KM_PER_NM * hours(fix.utc, anchor.utc) + GRID6_SLACK_KM;
}

/** Our Regular messages by cycle, each cycle's square put to a vote by
 * distinct station. A tied cycle has no square. */
class Squares {
  grid = new Map<string, string | null>();
  cycles: string[];

  constructor(regulars: Spot[]) {
    const byCycle = new Map<string, Map<string, Set<string>>>();
    for (const spot of regulars) {
      const grid4 = (spot.tx_loc ?? "").slice(0, 4).toUpperCase();
      if (grid4.length !== 4) continue;
      let byGrid = byCycle.get(spot.time);
      if (!byGrid) byCycle.set(spot.time, (byGrid = new Map()));
      let rxs = byGrid.get(grid4);
      if (!rxs) byGrid.set(grid4, (rxs = new Set()));
      rxs.add(spot.rx_sign);
    }
    for (const [cycle, byGrid] of byCycle) {
      const ranked = [...byGrid.entries()]
        .map(([g, r]) => [g, r.size] as const)
        .sort((a, b) => b[1] - a[1]);
      this.grid.set(cycle,
        ranked.length >= 2 && ranked[0]![1] === ranked[1]![1] ? null : ranked[0]![0]);
    }
    this.cycles = [...this.grid.keys()].sort();
  }

  before(cycle: string): string | null {
    let out: string | null = null;
    for (const c of this.cycles) {
      if (c >= cycle) break;
      out = c;
    }
    return out;
  }

  after(cycle: string): string | null {
    return this.cycles.find((c) => c > cycle) ?? null;
  }

  /** [grid4 or null, how it was found, or why not]. */
  squareFor(cycle: string): [string | null, string] {
    if (this.grid.has(cycle)) {
      const g = this.grid.get(cycle)!;
      return g === null
        ? [null, "this cycle's Regular reports disagree"]
        : [g, `same cycle ${g}`];
    }
    const b = this.before(cycle);
    const a = this.after(cycle);
    const t = ms(cycle);
    if (b === null || t - ms(b) > NEIGHBOUR_WINDOW_MS) {
      return [null, "no Regular heard in or just before this cycle"];
    }
    if (a === null || ms(a) - t > NEIGHBOUR_WINDOW_MS) {
      return [null, "no Regular heard in or just after this cycle"];
    }
    const gb = this.grid.get(b)!;
    const ga = this.grid.get(a)!;
    if (gb === null || ga === null) {
      return [null, "a neighbouring cycle's Regular reports disagree"];
    }
    if (gb !== ga) {
      return [null, `neighbours disagree: ${b.slice(11, 16)} ${gb}, ${a.slice(11, 16)} ${ga}`];
    }
    return [gb, `neighbours ${b.slice(11, 16)}+${a.slice(11, 16)} ${gb}`];
  }
}

type PayloadKey = [string, string, number];

/** One entry per distinct message, in-lane reports only, sorted the way
 * Python sorts its (tx_sign, tx_loc, power) tuples. */
function payloads(spots: Spot[], ch: Channel): [PayloadKey, Spot[]][] {
  const out = new Map<string, [PayloadKey, Spot[]]>();
  for (const s of spots) {
    if (!inLane(s.frequency, ch)) continue;
    const key: PayloadKey = [s.tx_sign, s.tx_loc, Number(s.power)];
    const k = key.join("\u0000");
    const have = out.get(k);
    if (have) have[1].push(s);
    else out.set(k, [key, [s]]);
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...out.values()].sort(([a], [b]) =>
    cmp(a[0], b[0]) || cmp(a[1], b[1]) || a[2] - b[2]);
}

function plausiblePosition(
  lat: number, lon: number, cycle: string, kt: number, slackKm: number,
  anchor: KnownFix | null, squares: Squares,
): string | null {
  if (!anchor) return "no earlier believed fix to check against";
  let km = haversineKm(anchor.lat, anchor.lon, lat, lon);
  let allowed = reachKm(hours(cycle, anchor.utc), kt) + slackKm + GRID6_SLACK_KM;
  if (km > allowed) {
    return `${f0(km)} km from the ${anchor.utc.slice(5, 16)} fix, `
      + `more than ${f0(allowed)} km allowed`;
  }
  for (const other of [squares.before(cycle), squares.after(cycle)]) {
    if (other === null || squares.grid.get(other) == null) continue;
    const g = squares.grid.get(other)!;
    const [glat, glon] = maidenheadToLatLon(g);
    km = haversineKm(glat, glon, lat, lon);
    allowed = reachKm(hours(cycle, other), kt) + slackKm + GRID4_SLACK_KM;
    if (km > allowed) {
      return `${f0(km)} km from the ${other.slice(11, 16)} square ${g}, `
        + `more than ${f0(allowed)} km allowed`;
    }
  }
  return null;
}

function decoded<T>(f: () => T): T | null {
  try {
    return f();
  } catch (err) {
    if (err instanceof DecodeError) return null;
    throw err;
  }
}

/** The inferred tier for one flight. `fixes` is every fix already known,
 * oldest first; the confirmed* sets are the cycles the confirmed tier
 * filled, which are left alone. Mirrors infer.py's `infer`. */
export function infer(
  ch: Channel, regulars: Spot[], telemetrySpots: Spot[], sensorSpots: Spot[],
  fixes: KnownFix[], confirmedBasic: Set<string>, confirmedSensor: Set<string>,
): Inferred {
  const squares = new Squares(regulars);
  const byCycle = (spots: Spot[], minute: number, skip: Set<string>) => {
    const out = new Map<string, Spot[]>();
    for (const s of spots) {
      if (Number(s.time.slice(14, 16)) % 10 !== minute) continue;
      const c = cycleOf(s.time, ch.startMinute);
      if (skip.has(c)) continue;
      const list = out.get(c);
      if (list) list.push(s);
      else out.set(c, [s]);
    }
    return out;
  };
  const tel = byCycle(telemetrySpots, slotMinute(ch, 1), confirmedBasic);
  const sen = byCycle(sensorSpots, slotMinute(ch, BME280_SLOT), confirmedSensor);

  type Ev = [string, number, "fix" | "basic" | "sensor", KnownFix | string];
  const events: Ev[] = [
    ...fixes.map((f): Ev => [f.utc, 0, "fix", f]),
    ...[...tel.keys()].map((c): Ev => [c, 1, "basic", c]),
    ...[...sen.keys()].map((c): Ev => [c, 2, "sensor", c]),
  ];
  events.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));

  let anchor: KnownFix | null = null;
  let floatRef: KnownFix | null = null;
  const fixAt = new Map<string, KnownFix>(fixes.map((f) => [f.utc, f]));
  const out: Inferred = { fixes: [], sensors: new Map(), decisions: [] };

  for (const [, , kind, item] of events) {
    if (kind === "fix") {
      const f = item as KnownFix;
      if (believable(f, anchor)) {
        anchor = f;
        if ((f.tier ?? "confirmed") !== "inferred") floatRef = f;
      }
      continue;
    }
    const cycle = item as string;
    const spots = (kind === "basic" ? tel : sen).get(cycle)!;
    const [grid4, gridHow] = squares.squareFor(cycle);
    const candidates = payloads(spots, ch);
    if (!candidates.length) {
      out.decisions.push({ cycleUtc: cycle, kind, outcome: "rejected", reason: "no report inside the lane" });
      continue;
    }
    const passed: [PayloadKey, Spot[], Record<string, number | string | boolean>][] = [];
    const why: string[] = [];
    for (const [key, reports] of candidates) {
      const [cs, loc, pwr] = key;
      const label = `${cs} ${loc} ${pwr}`;
      if (kind === "basic") {
        const c = decoded(() => decodeCallsign(cs));
        const g = c && decoded(() => decodeGridPower(loc, pwr));
        if (!c || !g || g.hdrType !== 1) { why.push(`${label}: not basic telemetry`); continue; }
        if (!g.gpsValid) { why.push(`${label}: GPS not valid`); continue; }
        if (grid4 === null) { why.push(`${label}: ${gridHow}`); continue; }
        const grid6 = grid4 + c.grid5.toLowerCase() + c.grid6.toLowerCase();
        const [lat, lon] = maidenheadToLatLon(grid6);
        let bad = plausiblePosition(lat, lon, cycle, g.speedKnots, GRID6_SLACK_KM, anchor, squares);
        if (bad === null) {
          if (!floatRef) bad = "no earlier confirmed fix to take float from";
          else if (Math.abs(c.altitudeM - floatRef.altitude_m) > MAX_FLOAT_DEPARTURE_M) {
            bad = `altitude ${c.altitudeM} m is more than ${MAX_FLOAT_DEPARTURE_M} m `
              + `from float, ${floatRef.altitude_m} m at ${floatRef.utc.slice(5, 16)}`;
          }
        }
        if (bad !== null) { why.push(`${label}: ${bad}`); continue; }
        passed.push([key, reports, {
          grid6, lat, lon, altitude_m: c.altitudeM, speed_kt: g.speedKnots,
          voltage_v: g.voltageV, temperature_c: g.temperatureC, gps_valid: g.gpsValid,
        }]);
      } else {
        const r = decoded(() => decodeBme280Slot3(cs, loc, pwr));
        if (!r) { why.push(`${label}: not the sensor message`); continue; }
        if (sensorFailed(r)) { why.push(`${label}: the sensor did not answer`); continue; }
        if (grid4 === null) { why.push(`${label}: ${gridHow}`); continue; }
        const [glat, glon] = maidenheadToLatLon(grid4);
        const own = fixAt.get(cycle);
        let bad: string | null = null;
        if (!own) bad = plausiblePosition(glat, glon, cycle, 0, GRID4_SLACK_KM, anchor, squares);
        const ref = own ?? floatRef;
        if (bad === null) {
          const pa = pressureAltitudeM(r.pressureHpa);
          if (!ref) bad = "no earlier confirmed fix to take float from";
          else if (Math.abs(pa - ref.altitude_m) > MAX_FLOAT_DEPARTURE_M) {
            bad = `pressure altitude ${f0(pa)} m is more than ${MAX_FLOAT_DEPARTURE_M} m `
              + `from ${ref.altitude_m} m at ${ref.utc.slice(5, 16)}`;
          }
        }
        if (bad !== null) { why.push(`${label}: ${bad}`); continue; }
        passed.push([key, reports, {
          pressure_hpa: r.pressureHpa, board_temp_c: r.temperatureC, humidity_pct: r.humidityPct,
        }]);
      }
    }

    if (!passed.length) {
      const outcome = grid4 === null && why.some((w) => w.includes(gridHow))
        ? "unplaced" : "rejected";
      out.decisions.push({ cycleUtc: cycle, kind, outcome, reason: why.join("; ") });
      continue;
    }
    if (passed.length > 1) {
      const names = passed.map(([k]) => `${k[0]} ${k[1]} ${k[2]}`).join(", ");
      out.decisions.push({
        cycleUtc: cycle, kind, outcome: "ambiguous",
        reason: `${passed.length} messages pass: ${names}`,
      });
      continue;
    }

    const [, reports, fields] = passed[0]!;
    const rxs = [...new Set(reports.map((s) => s.rx_sign))].sort();
    const freqs = [...new Set(reports.map((s) => Number(s.frequency)))].sort((a, b) => a - b);
    const reason = `cross-receiver; grid ${gridHow}; heard by ${rxs.join(", ")} `
      + `at ${freqs.join("/")} Hz; sole candidate`;
    out.decisions.push({ cycleUtc: cycle, kind, outcome: "inferred", reason });
    if (kind === "basic") {
      const fix = {
        utc: cycle, ...fields, rx_station_count: rxs.length,
        tier: "inferred", pairing: reason,
      } as InferredFix;
      out.fixes.push(fix);
      fixAt.set(cycle, fix);
      anchor = fix;
    } else {
      out.sensors.set(cycle, {
        ...(fields as Pick<InferredSensor, "pressure_hpa" | "board_temp_c" | "humidity_pct">),
        sensor_tier: "inferred", sensor_pairing: reason, grid4: grid4!,
        rx_station_count: rxs.length,
      });
    }
  }
  return out;
}
