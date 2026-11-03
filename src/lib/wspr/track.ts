/** Raw spots to a decoded track: the browser-side equivalent of
 * tool/picolog/pipeline.py's decode step.
 *
 * The authoritative flight record is still the operator's local SQLite file.
 * This exists so the page can show the newest fixes without waiting for any
 * server to run, and it must agree with the Python row for row; see
 * dev/verify-port.ts.
 *
 * Emits the site's shared TrackPoint, so a track decoded here and a track
 * read from the committed file are the same shape and feed the same
 * renderer. The Python's internal `speed_knots` is `speed_kt` here, the same
 * rename tool/picolog/export_site.py performs on its way out.
 */
import type { GhostPoint, TrackPoint } from "../types";
import { channel20m, slotMinute, type Channel } from "./channels";
import {
  BME280_SLOT, DecodeError, decodeBme280Slot3, decodeCallsign, decodeGridPower,
  maidenheadToLatLon, sensorFailed,
} from "./decode";
import { infer, type Decision, type KnownFix } from "./infer";
import {
  fingerprintMatch, MATCHER_NAME, MATCHER_VERSION, regularOnlySlots, type Match,
} from "./match";
import {
  BAND_CODES, fetchSpots, regularSpotsQuery, telemetryCandidatesQuery, type Spot,
} from "./query";

export { MATCHER_NAME, MATCHER_VERSION };

export interface FlightSpec {
  callsign: string;
  band: string;
  channel: number;
  /** The sensor the tracker carries, from flights.toml. With "bme280" the
   * slot-3 message is fetched too and its reading rides on each fix. */
  sensor?: "bme280" | null;
}

/** The sensor fields of a track point from a matched slot-3 pair, or null
 * when the payload is not the Petrel BME280 message or the sensor did not
 * answer. Mirrors tool/picolog/pipeline.py's _decode_sensor_match. */
export function decodeSensorMatch(
  m: Match,
): Pick<TrackPoint, "pressure_hpa" | "board_temp_c" | "humidity_pct"> | null {
  const spot = m.telemetrySpot;
  let reading;
  try {
    reading = decodeBme280Slot3(spot.tx_sign, spot.tx_loc, Number(spot.power));
  } catch (err) {
    if (err instanceof DecodeError) return null;
    throw err;
  }
  if (sensorFailed(reading)) return null;
  return {
    pressure_hpa: reading.pressureHpa,
    board_temp_c: reading.temperatureC,
    humidity_pct: reading.humidityPct,
  };
}

/** Turn a matched spot pair into a track point, or null when the paired
 * payload is not decodable Basic Telemetry (a false WSPR decode, or an
 * extended-telemetry packet). */
export function decodeMatch(m: Match): TrackPoint | null {
  let callsignPart, gridPowerPart;
  try {
    callsignPart = decodeCallsign(m.telemetrySpot.tx_sign);
    gridPowerPart = decodeGridPower(m.telemetrySpot.tx_loc, Number(m.telemetrySpot.power));
  } catch (err) {
    if (err instanceof DecodeError) return null;
    throw err;
  }
  if (gridPowerPart.hdrType !== 1) return null; // 1 = standard Basic Telemetry

  const grid6 = m.regularSpot.tx_loc.slice(0, 4).toUpperCase()
    + callsignPart.grid5.toLowerCase()
    + callsignPart.grid6.toLowerCase();
  const [lat, lon] = maidenheadToLatLon(grid6);
  return {
    utc: m.slotUtc,
    grid6,
    lat,
    lon,
    altitude_m: callsignPart.altitudeM,
    speed_kt: gridPowerPart.speedKnots,
    voltage_v: gridPowerPart.voltageV,
    temperature_c: gridPowerPart.temperatureC,
    gps_valid: gridPowerPart.gpsValid,
    rx_station_count: m.rxStationCount,
  };
}

/** Everything one window of raw spots decodes to: the full fixes, and the
 * slots where only the Regular message was heard. */
export interface DecodedWindow {
  track: TrackPoint[];
  ghosts: GhostPoint[];
  /** What the inferred tier decided about each cycle it looked at. */
  decisions: Decision[];
}

/** A track point as the inferred tier reads a fix. */
function knownFix(p: TrackPoint): KnownFix {
  return {
    utc: p.utc.slice(0, 19).replace("T", " "), lat: p.lat, lon: p.lon,
    altitude_m: p.altitude_m, pressure_hpa: p.pressure_hpa ?? null,
    tier: p.tier ?? "confirmed",
  };
}

type SensorFields = Pick<TrackPoint,
  "pressure_hpa" | "board_temp_c" | "humidity_pct" | "sensor_tier" | "sensor_pairing">;

/** Decode a whole window of raw spots, both halves oldest first, and the
 * sensor candidates too when there are any.
 *
 * A slot is a ghost when the matcher paired nothing in it, or when it did
 * and the pair turned out not to be Basic Telemetry: either way the tracker
 * was heard and its grid square is all that is known. A slot never appears
 * in both lists.
 *
 * Two pairing tiers (docs/cross-receiver-pairing.md). The confirmed tier
 * is the same-station fingerprint, as it always was. The inferred tier
 * (wspr/infer.ts) then tries the cycles it left empty, and marks what it
 * accepts with `tier: "inferred"`. It needs the channel, for the lane and
 * the slot minutes, and runs only when given one. It measures each
 * candidate against the last fix before it, so `context` hands it the
 * fixes already known from before this window: the bundled track, on a
 * live refresh.
 *
 * The sensor message, six minutes after the Regular, is paired the same
 * way, by either tier, and rides on its cycle's fix. A cycle with no fix
 * carries it on its ghost instead, and where the cycle had no Regular
 * either, the inferred tier's square makes the ghost. A fix whose sensor
 * message was not heard simply lacks the fields. Mirrors
 * tool/picolog/pipeline.py's rebuild_flight_telemetry. */
export function decodeWindow(
  regularSpots: Spot[], telemetrySpots: Spot[], sensorSpots: Spot[] = [],
  opts: { channel?: Channel; context?: TrackPoint[] } = {},
): DecodedWindow {
  const ch = opts.channel;
  const context = opts.context ?? [];
  const sensorBySlot = new Map<string, SensorFields & { grid4?: string; rx_station_count?: number }>();
  for (const m of fingerprintMatch(
    regularSpots, sensorSpots, undefined, 2 * BME280_SLOT,
  )) {
    const reading = decodeSensorMatch(m);
    if (reading) sensorBySlot.set(m.slotUtc, reading);
  }
  const matches = fingerprintMatch(regularSpots, telemetrySpots);
  let track: TrackPoint[] = [];
  const decoded: Match[] = [];
  for (const m of matches) {
    const p = decodeMatch(m);
    if (p) {
      track.push(p);
      decoded.push(m);
    }
  }

  let decisions: Decision[] = [];
  if (ch) {
    const held = [...regularSpots, ...telemetrySpots, ...sensorSpots].map((s) => s.time).sort();
    const first = held[0];
    const known = [
      ...context.map(knownFix).filter((f) => first === undefined || f.utc < first),
      // With their confirmed sensor readings: the spoof rule that picks
      // the fix to measure from reads the pressure.
      ...track.map((p) => knownFix({ ...p, ...sensorBySlot.get(p.utc) })),
    ].sort((a, b) => (a.utc < b.utc ? -1 : a.utc > b.utc ? 1 : 0));
    const inf = infer(ch, regularSpots, telemetrySpots, sensorSpots, known,
      new Set(track.map((p) => p.utc)), new Set(sensorBySlot.keys()));
    track = [...track, ...inf.fixes].sort((a, b) => a.utc.localeCompare(b.utc));
    for (const [cycle, reading] of inf.sensors) sensorBySlot.set(cycle, reading);
    decisions = inf.decisions;
  }
  const sensorOnly = ({ grid4: _g, rx_station_count: _n, ...rest }:
    SensorFields & { grid4?: string; rx_station_count?: number }) => rest;
  track = track.map((p) => {
    const reading = sensorBySlot.get(p.utc);
    return reading ? { ...p, ...sensorOnly(reading) } : p;
  });

  const fixed = new Set(track.map((p) => p.utc));
  const ghosts: GhostPoint[] = regularOnlySlots(regularSpots, decoded)
    .filter((g) => !fixed.has(g.slotUtc))
    .map((g) => {
      const [lat, lon] = maidenheadToLatLon(g.grid4);
      return {
        utc: g.slotUtc, grid4: g.grid4, lat, lon, rx_station_count: g.rxStationCount,
      };
    });
  const byUtc = new Map(ghosts.map((g) => [g.utc, g]));
  for (const [cycle, reading] of sensorBySlot) {
    if (fixed.has(cycle)) continue;
    let ghost = byUtc.get(cycle);
    if (!ghost) {
      if (reading.grid4 === undefined) continue; // confirmed, but its cycle's square was tied
      const [lat, lon] = maidenheadToLatLon(reading.grid4);
      ghost = {
        utc: cycle, grid4: reading.grid4, lat, lon,
        rx_station_count: reading.rx_station_count!, grid_source: "neighbours",
      };
      ghosts.push(ghost);
      byUtc.set(cycle, ghost);
    }
    Object.assign(ghost, sensorOnly(reading));
  }
  ghosts.sort((a, b) => a.utc.localeCompare(b.utc));
  return { track, ghosts, decisions };
}

/** Fetch and decode one window straight from wspr.live.
 *
 * The queries are independent, so they go out together: one round trip
 * instead of two or three, which roughly halves the wait. The third, for the
 * slot-3 sensor message, only goes out for a tracker that sends one.
 */
export async function fetchWindow(
  flight: FlightSpec, windowStart: Date, windowEnd: Date, signal?: AbortSignal,
  /** Fixes known from before the window (decodeWindow's `context`). */
  context: TrackPoint[] = [],
): Promise<DecodedWindow> {
  const band = BAND_CODES[flight.band];
  if (band === undefined) throw new Error(`unsupported band: ${flight.band}`);
  const ch: Channel = channel20m(flight.channel);
  const [regular, telemetry, sensor] = await Promise.all([
    fetchSpots(
      regularSpotsQuery(flight.callsign, band, ch.startMinute, windowStart, windowEnd),
      signal,
    ),
    fetchSpots(
      telemetryCandidatesQuery(ch.id13, band, ch.telemetryMinute, windowStart, windowEnd),
      signal,
    ),
    flight.sensor === "bme280"
      ? fetchSpots(
        telemetryCandidatesQuery(
          ch.id13, band, slotMinute(ch, BME280_SLOT), windowStart, windowEnd),
        signal,
      )
      : Promise.resolve([] as Spot[]),
  ]);
  return decodeWindow(regular, telemetry, sensor, { channel: ch, context });
}

/** Merge newly decoded points into an existing track; the newer decode wins a
 * collision. Used to append a live tail onto the track bundled with the page. */
export function mergeTrack<P extends { utc: string }>(base: P[], incoming: P[]): P[] {
  const byUtc = new Map<string, P>();
  for (const p of base) byUtc.set(p.utc, p);
  for (const p of incoming) byUtc.set(p.utc, p);
  return [...byUtc.values()].sort((a, b) => a.utc.localeCompare(b.utc));
}
