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
}

/** Decode a whole window of raw spots, both halves oldest first, and the
 * sensor candidates too when there are any.
 *
 * A slot is a ghost when the matcher paired nothing in it, or when it did
 * and the pair turned out not to be Basic Telemetry: either way the tracker
 * was heard and its grid square is all that is known. A slot never appears
 * in both lists.
 *
 * The sensor message, six minutes after the Regular, is paired the same way
 * and rides on the fix: a slot whose Basic Telemetry was not heard has no
 * position for the reading to belong to, so a sensor-only slot is dropped,
 * and a fix whose sensor message was not heard simply lacks the fields. */
export function decodeWindow(
  regularSpots: Spot[], telemetrySpots: Spot[], sensorSpots: Spot[] = [],
): DecodedWindow {
  const sensorBySlot = new Map<string, NonNullable<ReturnType<typeof decodeSensorMatch>>>();
  for (const m of fingerprintMatch(
    regularSpots, sensorSpots, undefined, 2 * BME280_SLOT,
  )) {
    const reading = decodeSensorMatch(m);
    if (reading) sensorBySlot.set(m.slotUtc, reading);
  }
  const matches = fingerprintMatch(regularSpots, telemetrySpots);
  const track: TrackPoint[] = [];
  const decoded: Match[] = [];
  for (const m of matches) {
    const p = decodeMatch(m);
    if (p) {
      track.push({ ...p, ...sensorBySlot.get(m.slotUtc) });
      decoded.push(m);
    }
  }
  const ghosts = regularOnlySlots(regularSpots, decoded).map((g) => {
    const [lat, lon] = maidenheadToLatLon(g.grid4);
    return {
      utc: g.slotUtc, grid4: g.grid4, lat, lon, rx_station_count: g.rxStationCount,
    };
  });
  return { track, ghosts };
}

/** Fetch and decode one window straight from wspr.live.
 *
 * The queries are independent, so they go out together: one round trip
 * instead of two or three, which roughly halves the wait. The third, for the
 * slot-3 sensor message, only goes out for a tracker that sends one.
 */
export async function fetchWindow(
  flight: FlightSpec, windowStart: Date, windowEnd: Date, signal?: AbortSignal,
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
  return decodeWindow(regular, telemetry, sensor);
}

/** Merge newly decoded points into an existing track; the newer decode wins a
 * collision. Used to append a live tail onto the track bundled with the page. */
export function mergeTrack<P extends { utc: string }>(base: P[], incoming: P[]): P[] {
  const byUtc = new Map<string, P>();
  for (const p of base) byUtc.set(p.utc, p);
  for (const p of incoming) byUtc.set(p.utc, p);
  return [...byUtc.values()].sort((a, b) => a.utc.localeCompare(b.utc));
}
