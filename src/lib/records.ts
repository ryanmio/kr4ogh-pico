/** Records across every flight on the site: the longest, the farthest, the
 * highest, the fastest, and where each of those happened.
 *
 * Everything here derives from the tracks and the flight list, so a copy of
 * the site for another callsign gets its own records on its first build and
 * nothing is ever typed in by hand. Each flight is reduced to a summary --
 * one value per record, and the fix it happened at -- and the summaries are
 * ranked. The summaries are what the page carries for the flights it is not
 * showing: a few numbers each, rather than every track.
 *
 * The values are the ones the cards already show, by the same code, so a
 * record can never disagree with the flight's own page: time aloft counts
 * the ghosts the way the Signal card does, distance is the Journey card's,
 * speed goes through lib/speed.ts and so carries the floor where the
 * telemetry field saturated.
 *
 * Pure, and shared: the build runs it over the committed tracks and the
 * browser runs it again over the live one.
 */
import {
  fmtDuration, haversineKm, parseUtc, trackStats,
} from "./format";
import { heardBounds } from "./ghosts";
import { groundSpeedKt, isSpeedFloor } from "./speed";
import type { FlightMeta, GhostPoint, TrackPoint } from "./types";
import * as u from "./units";
import type { Units } from "./units";

export type RecordKey =
  | "longest" | "distance" | "farthest" | "highest" | "fastest"
  | "receivers" | "coldest";

/** A fix: when and where. */
export interface Spot {
  utc: string;
  lat: number;
  lon: number;
}

/** One flight reduced to its record-worthy numbers. */
export interface FlightSummary {
  flight_id: string;
  callsign: string;
  status: "live" | "closed";
  /** When the tracker was first and last heard at all, ghosts included. */
  firstUtc: string;
  lastUtc: string;
  /** Full fixes decoded. */
  points: number;
  /** The value for each record, in the stored units: milliseconds, km,
   * metres, knots, stations, °C. */
  values: Record<RecordKey, number>;
  /** Where each happened. The longest flight and the farthest travelled
   * both point at the end of the track, which is where those were true. */
  at: Record<RecordKey, Spot>;
  /** True when the fastest fix is only a floor: the field saturated and
   * the track gave no better measurement (lib/speed.ts). */
  fastestFloor: boolean;
}

export interface RecordDef {
  key: RecordKey;
  /** The record's name on a tile. */
  label: string;
  /** On a map pin, where there is no room. */
  short: string;
  /** Which way is better. */
  better: "max" | "min";
  /** The value for display, in the reader's units. */
  fmt(value: number, units: Units, s: FlightSummary): string;
}

export const RECORDS: RecordDef[] = [
  { key: "longest", label: "Longest flight", short: "Longest", better: "max",
    fmt: (v) => fmtDuration(v) },
  { key: "distance", label: "Farthest travelled", short: "Farthest", better: "max",
    fmt: (v, units) => u.distance(v, units).text },
  { key: "farthest", label: "Farthest from launch", short: "From launch", better: "max",
    fmt: (v, units) => u.distance(v, units).text },
  { key: "highest", label: "Highest", short: "Highest", better: "max",
    fmt: (v, units) => u.altitude(v, units).text },
  { key: "fastest", label: "Fastest", short: "Fastest", better: "max",
    // A floor is marked the way the speed card marks it: the tracker
    // proved at least this much, and the track could not say more.
    fmt: (v, units, s) => {
      const m = u.speed(v, units);
      return s.fastestFloor ? `${m.value.toLocaleString("en-US")}+ ${m.unit}` : m.text;
    } },
  { key: "receivers", label: "Most receivers", short: "Most heard", better: "max",
    fmt: (v) => `${v} stations` },
  { key: "coldest", label: "Coldest", short: "Coldest", better: "min",
    fmt: (v, units) => u.temperature(v, units).text },
];

export function isRecordKey(v: unknown): v is RecordKey {
  return typeof v === "string" && RECORDS.some((r) => r.key === v);
}

function spot(p: TrackPoint): Spot {
  return { utc: p.utc, lat: p.lat, lon: p.lon };
}

/** The fix where `pick` is most extreme, the earliest when tied. */
function extreme(
  track: TrackPoint[], pick: (p: TrackPoint) => number, better: "max" | "min",
): TrackPoint {
  return track.reduce((best, p) => {
    const a = pick(p);
    const b = pick(best);
    return (better === "max" ? a > b : a < b) ? p : best;
  });
}

/** A flight's summary, or null for a flight with no decoded telemetry
 * yet: a grid square alone sets no record. */
export function summarize(
  meta: FlightMeta, track: TrackPoint[], ghosts: GhostPoint[] = [],
): FlightSummary | null {
  const s = trackStats(track);
  if (!s) return null;
  const heard = heardBounds(track, ghosts)!;
  const aloftMs = parseUtc(heard.lastUtc).getTime() - parseUtc(heard.firstUtc).getTime();
  // From the first fix, as the Journey card's "from launch" is.
  const origin = track[0]!;
  const far = extreme(track, (p) => haversineKm(origin.lat, origin.lon, p.lat, p.lon), "max");
  const fast = extreme(track, groundSpeedKt, "max");
  const high = extreme(track, (p) => p.altitude_m, "max");
  const heardBy = extreme(track, (p) => p.rx_station_count, "max");
  const cold = extreme(track, (p) => p.temperature_c, "min");
  return {
    flight_id: meta.flight_id,
    callsign: meta.callsign,
    status: meta.status,
    firstUtc: heard.firstUtc,
    lastUtc: heard.lastUtc,
    points: s.points,
    values: {
      longest: aloftMs,
      distance: s.distanceKm,
      farthest: haversineKm(origin.lat, origin.lon, far.lat, far.lon),
      highest: high.altitude_m,
      fastest: groundSpeedKt(fast),
      receivers: heardBy.rx_station_count,
      coldest: cold.temperature_c,
    },
    at: {
      longest: spot(s.last),
      distance: spot(s.last),
      farthest: spot(far),
      highest: spot(high),
      fastest: spot(fast),
      receivers: spot(heardBy),
      coldest: spot(cold),
    },
    fastestFloor: isSpeedFloor(fast),
  };
}

export type Holders = Partial<Record<RecordKey, FlightSummary>>;

/** Who holds each record. Summaries are taken in the order given, which
 * is the site's launch order, and a record changes hands only when it is
 * beaten, not matched: the earlier flight keeps a tie. */
export function recordHolders(summaries: FlightSummary[]): Holders {
  const holders: Holders = {};
  for (const r of RECORDS) {
    for (const s of summaries) {
      const held = holders[r.key];
      if (!held) {
        holders[r.key] = s;
        continue;
      }
      const a = s.values[r.key];
      const b = held.values[r.key];
      if (r.better === "max" ? a > b : a < b) holders[r.key] = s;
    }
  }
  return holders;
}

/** How many of the records a flight holds. */
export function recordsHeldBy(flightId: string, holders: Holders): number {
  return RECORDS.filter((r) => holders[r.key]?.flight_id === flightId).length;
}

/** A pin on the map: one place where one or more records were set. */
export interface RecordPin {
  flight_id: string;
  utc: string;
  lat: number;
  lon: number;
  keys: RecordKey[];
  /** "Highest 11,000 m · Coldest −29 °C": the records set at this fix. */
  label: string;
}

/** The pins for a set of holders. Records set at the same fix of the same
 * flight share one pin, since two labels on one spot would cover each
 * other: a flight whose last fix is both its farthest and the end of the
 * longest flight gets one star saying both. */
export function recordPins(holders: Holders, units: Units): RecordPin[] {
  const pins = new Map<string, RecordPin>();
  for (const r of RECORDS) {
    const s = holders[r.key];
    if (!s) continue;
    const at = s.at[r.key];
    const id = `${s.flight_id}|${at.utc}`;
    const text = `${r.short} ${r.fmt(s.values[r.key], units, s)}`;
    const pin = pins.get(id);
    if (pin) {
      pin.keys.push(r.key);
      pin.label += ` · ${text}`;
    } else {
      pins.set(id, {
        flight_id: s.flight_id, utc: at.utc, lat: at.lat, lon: at.lon,
        keys: [r.key], label: text,
      });
    }
  }
  return [...pins.values()];
}
