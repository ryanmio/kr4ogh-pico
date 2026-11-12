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
 * Three of the records are crossings -- the Atlantic, half the globe, all
 * of it -- which most flights never make. A flight that has not made one
 * has no value for it, and a crossing no flight has made is not shown
 * anywhere, so the circumnavigation appears the day a flight completes one.
 *
 * Pure, and shared: the build runs it over the committed tracks and the
 * browser runs it again over the live one.
 */
import { unwrapLons } from "./basemap";
import {
  fmtDuration, haversineKm, isInferred, parseUtc, trackStats,
} from "./format";
import { heardBounds } from "./ghosts";
import { groundSpeedKt, isSpeedFloor } from "./speed";
import type { FlightMeta, GhostPoint, TrackPoint } from "./types";
import * as u from "./units";
import type { Units } from "./units";

export type RecordKey =
  | "longest" | "distance" | "farthest" | "highest" | "fastest"
  | "receivers" | "coldest" | CrossingKey;

/** The records a flight sets only by getting somewhere. */
export type CrossingKey = "atlantic" | "half" | "around";

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
   * metres, knots, stations, °C. A crossing the flight has not made has
   * no value, and no spot. */
  values: Partial<Record<RecordKey, number>>;
  /** Where each happened. The longest flight and the farthest travelled
   * both point at the end of the track, which is where those were true;
   * a crossing points at the first fix past its line. */
  at: Partial<Record<RecordKey, Spot>>;
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
  /** A crossing: shown only once some flight has made it, and in the
   * table's one Crossings column rather than a column of its own. */
  crossing?: true;
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
  // Each is the time from first heard -- the start the longest flight
  // counts from -- to the first fix past the line. Solar trackers sleep
  // at night, so that fix is often the next morning's: the time is when
  // the flight was first heard across, never a guess at when it crossed.
  { key: "atlantic", label: "Atlantic crossing", short: "Atlantic", better: "min",
    crossing: true, fmt: (v) => fmtDuration(v) },
  { key: "half", label: "Half circumnavigation", short: "Halfway round", better: "min",
    crossing: true, fmt: (v) => fmtDuration(v) },
  { key: "around", label: "Circumnavigation", short: "Round the world", better: "min",
    crossing: true, fmt: (v) => fmtDuration(v) },
];

export function isRecordKey(v: unknown): v is RecordKey {
  return typeof v === "string" && RECORDS.some((r) => r.key === v);
}

/** The eastern shore of the Atlantic, north to south as [lat, lon]: Norway,
 * across the mouth of the North Sea to Shetland, the Hebrides, Ireland,
 * across Biscay to Galicia, Portugal, Morocco, the Sahara coast, Senegal,
 * and down to Cape Palmas, where Africa turns east. Coarse, on purpose: it
 * is a finish line, not a coastline. Islands are on the ocean side of it,
 * so the Azores, Canaries and Cape Verde do not finish a crossing; Europe
 * and Africa both do, since a balloon riding the subtropical jet reaches
 * the Sahara, not Europe, and has crossed all the same. */
const EAST_ATLANTIC: [number, number][] = [
  [71, 24], [68, 13], [63, 7], [61, 4.8], [59.5, -1], [58.5, -7],
  [55, -8.5], [52, -10.5], [51.4, -10], [48.4, -5], [43.2, -9.3],
  [37, -9], [35.8, -6], [33.5, -7.7], [31, -9.8], [28, -12], [26, -14.5],
  [21, -17], [15, -17.5], [10, -14.5], [4.4, -7.7],
];

/** The finish line's longitude at a latitude. North and south of the line
 * it carries on along the meridian of its last point. */
export function eastAtlanticLon(lat: number): number {
  const line = EAST_ATLANTIC;
  if (lat >= line[0]![0]) return line[0]![1];
  for (let i = 1; i < line.length; i++) {
    const [la, lo] = line[i]!;
    const [pla, plo] = line[i - 1]!;
    if (lat >= la) return lo + (plo - lo) * (lat - la) / (pla - la);
  }
  return line.at(-1)![1];
}

/** A flight starting west of this is starting from the Americas, and so
 * has an Atlantic in front of it. One launched in Europe has none. */
const ATLANTIC_START_LON = -50;

/** The crossings a track has made: for each, the first confirmed fix past
 * its line. Longitude is unwrapped along the track, so a flight's progress
 * round the globe is counted through the date line, and a westward flight
 * counts as much as an eastward one for going round. Unwrapping takes
 * neighbouring fixes as less than half the globe apart, which a balloon
 * never goes in the longest night a tracker sleeps through. Fixes only,
 * and confirmed ones: an inferred fix is a lower-confidence pairing, too
 * weak alone to say a flight got somewhere. */
function crossings(track: TrackPoint[]): Partial<Record<CrossingKey, TrackPoint>> {
  const lons = unwrapLons(track);
  const start = lons[0]!;
  const out: Partial<Record<CrossingKey, TrackPoint>> = {};
  const atlantic = start < ATLANTIC_START_LON;
  for (let i = 0; i < track.length; i++) {
    const p = track[i]!;
    if (isInferred(p)) continue;
    const lon = lons[i]!;
    const gone = Math.abs(lon - start);
    if (atlantic && !out.atlantic && lon > eastAtlanticLon(p.lat)) out.atlantic = p;
    if (!out.half && gone >= 180) out.half = p;
    if (!out.around && gone >= 360) out.around = p;
  }
  return out;
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
  spoofed: TrackPoint[] = [],
): FlightSummary | null {
  const s = trackStats(track);
  if (!s) return null;
  // A record read off one fix (highest, fastest, most heard, coldest) is
  // set by a confirmed fix only: an inferred one is a lower-confidence
  // pairing (docs/cross-receiver-pairing.md). Distances and time aloft
  // take every fix.
  const confirmed = track.filter((p) => !isInferred(p));
  if (!confirmed.length) return null;
  const heard = heardBounds(track, ghosts, spoofed)!;
  const aloftMs = parseUtc(heard.lastUtc).getTime() - parseUtc(heard.firstUtc).getTime();
  // From the first fix, as the Journey card's "from launch" is.
  const origin = track[0]!;
  const far = extreme(track, (p) => haversineKm(origin.lat, origin.lon, p.lat, p.lon), "max");
  const fast = extreme(confirmed, groundSpeedKt, "max");
  const high = extreme(confirmed, (p) => p.altitude_m, "max");
  const heardBy = extreme(confirmed, (p) => p.rx_station_count, "max");
  const cold = extreme(confirmed, (p) => p.temperature_c, "min");
  const start = parseUtc(heard.firstUtc).getTime();
  const crossed = crossings(track);
  const values: FlightSummary["values"] = {
    longest: aloftMs,
    distance: s.distanceKm,
    farthest: haversineKm(origin.lat, origin.lon, far.lat, far.lon),
    highest: high.altitude_m,
    fastest: groundSpeedKt(fast),
    receivers: heardBy.rx_station_count,
    coldest: cold.temperature_c,
  };
  const at: FlightSummary["at"] = {
    longest: spot(s.last),
    distance: spot(s.last),
    farthest: spot(far),
    highest: spot(high),
    fastest: spot(fast),
    receivers: spot(heardBy),
    coldest: spot(cold),
  };
  for (const [key, p] of Object.entries(crossed) as [CrossingKey, TrackPoint][]) {
    values[key] = parseUtc(p.utc).getTime() - start;
    at[key] = spot(p);
  }
  return {
    flight_id: meta.flight_id,
    callsign: meta.callsign,
    status: meta.status,
    firstUtc: heard.firstUtc,
    lastUtc: heard.lastUtc,
    points: s.points,
    values,
    at,
    fastestFloor: isSpeedFloor(fast),
  };
}

export type Holders = Partial<Record<RecordKey, FlightSummary>>;

/** Who holds each record. Summaries are taken in the order given, which
 * is the site's launch order, and a record changes hands only when it is
 * beaten, not matched: the earlier flight keeps a tie. A flight that has
 * not made a crossing is not in the running for it, so a crossing nobody
 * has made has no holder. */
export function recordHolders(summaries: FlightSummary[]): Holders {
  const holders: Holders = {};
  for (const r of RECORDS) {
    for (const s of summaries) {
      const a = s.values[r.key];
      if (a === undefined) continue;
      const held = holders[r.key];
      if (!held) {
        holders[r.key] = s;
        continue;
      }
      const b = held.values[r.key]!;
      if (r.better === "max" ? a > b : a < b) holders[r.key] = s;
    }
  }
  return holders;
}

/** How many records are held at all: every one but the crossings nobody
 * has made. */
export function recordsSet(holders: Holders): number {
  return RECORDS.filter((r) => holders[r.key]).length;
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
    const at = s.at[r.key]!;
    const id = `${s.flight_id}|${at.utc}`;
    const text = `${r.short} ${r.fmt(s.values[r.key]!, units, s)}`;
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
