/** Decode U4B/Traquito Basic Telemetry from WSPR Type 1 message fields.
 *
 * A direct port of tool/picolog/decode.py, kept structurally identical so the
 * two can be audited against each other. Both are validated against the same
 * frozen vector (tool/tests/vectors/basic_telemetry.json); see
 * dev/verify-port.ts.
 *
 * Two independent unpack groups (see docs/telemetry-format.md):
 *   callsign chars 2,4,5,6  ->  grid5, grid6, altitude
 *   grid (4 chars) + power  ->  temperature, voltage, speed, gps_valid, hdr_type
 *
 * Callsign characters 1 and 3 are the channel's id13 and carry no telemetry.
 *
 * Packing order and bases are from the protocol author's published spec
 * (https://qrp-labs.com/flights/s4.html); Traquito-specific behaviour
 * (clamping, the 3.0-4.95 V window) from
 * https://traquito.github.io/pro/telemetry/basic/. Values were CLAMPED at
 * encode time, not rolled over, so a decoded boundary value may mean "at or
 * beyond the boundary".
 *
 * Extended Telemetry, the second half of this file, uses the same two field
 * groups as one combined number. The only extended message decoded here is
 * the Petrel tracker's BME280 sensor reading in slot 3; see
 * decodeBme280Slot3.
 */

// Value spaces of the two encode groups. If an unpack disagrees, the radix is wrong.
const CALLSIGN_GROUP_VALUES = 24 * 24 * 1068; // 615,168
const GRID_POWER_GROUP_VALUES = 90 * 40 * 42 * 2 * 2; // 604,800

// The 19 legal WSPR power levels in dBm ("the power is base 19").
const POWER_DBM_LEVELS = [0, 3, 7, 10, 13, 17, 20, 23, 27, 30, 33, 37, 40, 43,
  47, 50, 53, 57, 60];

const BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface CallsignTelemetry {
  grid5: string; // 5th Maidenhead character, A-X
  grid6: string; // 6th Maidenhead character, A-X
  altitudeM: number; // 0 to 21,340 in 20 m steps, clamped by Traquito
}

export interface GridPowerTelemetry {
  /** RP2040 die temperature, -50 to +39 C. NOT external air temperature. */
  temperatureC: number;
  voltageV: number; // 3.00 to 4.95 V in 0.05 V steps (Traquito window)
  // 0 to 82 in 2 kt steps, clamped by Traquito. 82 is the top of the field
  // and means "82 or faster"; ../speed.ts recovers the real number from the
  // distance flown, which needs the fixes either side and so cannot happen
  // in a per-message decoder.
  speedKnots: number;
  gpsValid: boolean; // always true from a Jetpack; a lock is required to send
  hdrType: number; // 1 = standard Basic Telemetry; anything else is not
}

/** Thrown where the Python raises ValueError: a malformed field, or a packed
 * value outside the Basic Telemetry space (a false WSPR decode, or extended
 * telemetry). Callers treat it as "not decodable", never as a crash. */
export class DecodeError extends Error {}

const isDigit = (c: string) => c >= "0" && c <= "9";

/** What the two field groups can hold at most, before any message's own
 * value space is applied: callsign chars 2,4,5,6 at bases 36,26,26,26 and
 * grid1-4 + power at bases 18,18,10,10,19. */
export const CALLSIGN_FIELD_VALUES = 36 * 26 * 26 * 26; // 632,736
export const GRID_POWER_FIELD_VALUES = 18 * 18 * 10 * 10 * 19; // 615,600

/** The number packed into a telemetry callsign's data characters 2,4,5,6,
 * most significant first. Validates the field, not the message: every
 * telemetry message, basic or extended, is read through this. */
export function callsignValue(callsign: string): number {
  const cs = callsign.trim().toUpperCase();
  if (cs.length !== 6) {
    throw new DecodeError(`telemetry callsign must be 6 chars: ${callsign}`);
  }
  if (!"01Q".includes(cs[0]) || !isDigit(cs[2])) {
    throw new DecodeError(`not a telemetry callsign (id13 malformed): ${callsign}`);
  }

  // Characters 1 and 3 are id13 and are deliberately not decoded here.
  const [c2, c4, c5, c6] = [cs[1], cs[3], cs[4], cs[5]];
  if (!BASE36.includes(c2)) {
    throw new DecodeError(`callsign char 2 out of range: ${callsign}`);
  }
  for (const c of [c4, c5, c6]) {
    if (!(c >= "A" && c <= "Z")) {
      throw new DecodeError(`callsign chars 4-6 must be A-Z: ${callsign}`);
    }
  }

  let n = BASE36.indexOf(c2);
  for (const c of [c4, c5, c6]) {
    n = n * 26 + (c.charCodeAt(0) - 65);
  }
  return n;
}

/** The number packed into a telemetry message's grid and power fields,
 * most significant first. Throws DecodeError if either field is malformed. */
export function gridPowerValue(grid: string, powerDbm: number): number {
  const g = grid.trim().toUpperCase();
  if (g.length !== 4 || !(g[0] >= "A" && g[0] <= "R") || !(g[1] >= "A" && g[1] <= "R")
      || !isDigit(g[2]) || !isDigit(g[3])) {
    throw new DecodeError(`not a WSPR Type 1 grid: ${grid}`);
  }
  if (!POWER_DBM_LEVELS.includes(powerDbm)) {
    throw new DecodeError(`not a legal WSPR power level: ${powerDbm}`);
  }

  let n = g.charCodeAt(0) - 65;
  n = n * 18 + (g.charCodeAt(1) - 65);
  n = n * 10 + Number(g[2]);
  n = n * 10 + Number(g[3]);
  n = n * 19 + POWER_DBM_LEVELS.indexOf(powerDbm);
  return n;
}

export function decodeCallsign(callsign: string): CallsignTelemetry {
  const n = callsignValue(callsign);
  if (n >= CALLSIGN_GROUP_VALUES) {
    throw new DecodeError(`callsign value ${n} outside Basic Telemetry space: ${callsign}`);
  }

  const altitudeIndex = n % 1068;
  const subsquare = Math.floor(n / 1068);
  const grid6 = subsquare % 24;
  const grid5 = Math.floor(subsquare / 24);
  return {
    grid5: String.fromCharCode(65 + grid5),
    grid6: String.fromCharCode(65 + grid6),
    altitudeM: altitudeIndex * 20,
  };
}

export function decodeGridPower(grid: string, powerDbm: number): GridPowerTelemetry {
  let n = gridPowerValue(grid, powerDbm);
  if (n >= GRID_POWER_GROUP_VALUES) {
    throw new DecodeError(`grid+power value ${n} outside Basic Telemetry space: ${grid} ${powerDbm}`);
  }

  const hdrType = n % 2;
  n = Math.floor(n / 2);
  const gpsValid = n % 2;
  n = Math.floor(n / 2);
  const speedIndex = n % 42;
  n = Math.floor(n / 42);
  const voltageIndex = n % 40;
  const temperatureIndex = Math.floor(n / 40);

  return {
    temperatureC: -50 + temperatureIndex,
    voltageV: decodeVoltage(voltageIndex),
    speedKnots: speedIndex * 2,
    gpsValid: Boolean(gpsValid),
    hdrType,
  };
}

/** Center of a 4- or 6-character Maidenhead locator box, in degrees —
 * the same convention wspr.live uses for its own lat/lon columns. */
export function maidenheadToLatLon(grid: string): [number, number] {
  const g = grid.trim().toUpperCase();
  if (g.length !== 4 && g.length !== 6) {
    throw new DecodeError(`locator must be 4 or 6 chars: ${grid}`);
  }
  let lon = (g.charCodeAt(0) - 65) * 20.0 - 180.0 + Number(g[2]) * 2.0;
  let lat = (g.charCodeAt(1) - 65) * 10.0 - 90.0 + Number(g[3]) * 1.0;
  if (g.length === 6) {
    lon += (g.charCodeAt(4) - 65) * 5.0 / 60.0 + 2.5 / 60.0;
    lat += (g.charCodeAt(5) - 65) * 2.5 / 60.0 + 1.25 / 60.0;
  } else {
    lon += 1.0;
    lat += 0.5;
  }
  return [round(lat, 5), round(lon, 5)];
}

function decodeVoltage(index: number): number {
  // The spec field is 2.0-3.95 V with rollover; Traquito clamps to the
  // 3.0-4.95 V window, which the rollover arithmetic maps to indexes 20-39
  // (3.00-3.95 V) and 0-19 (4.00-4.95 V).
  if (index < 20) return round(4.0 + index * 0.05, 2);
  return round(2.0 + index * 0.05, 2);
}

/** Python's round() to n places, via the same decimal-shift trick. Plain
 * toFixed rounds half-away-from-zero on some values where Python rounds
 * half-to-even, but every value here is a clean multiple of 0.05 or a
 * Maidenhead centre, so the shift is exact for the inputs in play. */
function round(x: number, places: number): number {
  const f = 10 ** places;
  return Math.round((x + Number.EPSILON * Math.sign(x)) * f) / f;
}

// ---------- Extended Telemetry: the Petrel BME280 message, slot 3 ----------
//
// An Extended Telemetry message packs the callsign group and the grid+power
// group into ONE number, callsign group most significant, and peels fields
// off it least significant first. Every extended message starts with four
// header fields; the user-defined fields follow in the order of the message
// definition (https://traquito.github.io/pro/telemetry/extended/).
//
//   HdrTelemetryType  radix 2   0 = extended (1 is Basic Telemetry's bit)
//   HdrRESERVED       radix 4   0
//   HdrType           radix 16  0 = user-defined
//   HdrSlot           radix 5   which of the five 2-minute slots carries it
//
// The Petrel tracker (https://github.com/ryanmio/petrel) sends its BME280
// reading in slot 3, the Regular message's slot plus six minutes, with this
// message definition, each a uniform field of step 1:
//
//   Temperature  -70 .. 50 C     radix 121   board temperature, not air
//   Pressure       0 .. 1100 hPa radix 1101  absolute, not sea-level adjusted
//   Humidity       0 .. 100 %    radix 101
//
// A reading of -70 / 0 / 0 is the tracker saying the sensor did not answer
// (the script's failure path sends the field minimums), never a measurement.
//
// Any other tracker's slot-3 message would pass the header checks and decode
// into nonsense here, so this is only applied to flights whose flights.toml
// entry says the tracker carries the sensor. A direct port of
// tool/picolog/decode.py's decode_bme280_slot3.

const EXTENDED_HEADER_RADICES = [2, 4, 16, 5]; // HdrTelemetryType, HdrRESERVED, HdrType, HdrSlot
const BME280_RADICES = [121, 1101, 101]; // Temperature, Pressure, Humidity
export const BME280_SLOT = 3;
const BME280_TEMPERATURE_LOW_C = -70;

/** Value space of the whole message: headers times fields, 8,611,405,440,
 * well inside the 389,512,281,600 the two field groups can carry, and well
 * inside a double's exact integers. */
export const BME280_MESSAGE_VALUES = 2 * 4 * 16 * 5 * 121 * 1101 * 101;

export interface Bme280Telemetry {
  temperatureC: number; // board temperature, -70 to 50 C
  pressureHpa: number; // absolute pressure, 0 to 1100 hPa
  humidityPct: number; // relative humidity, 0 to 100 %
}

/** The tracker was alive but the sensor did not answer. */
export function sensorFailed(t: Bme280Telemetry): boolean {
  return t.temperatureC === -70 && t.pressureHpa === 0 && t.humidityPct === 0;
}

/** Unpack the Petrel BME280 reading from a slot-3 telemetry message. Throws
 * DecodeError if the fields are malformed, the packed value lies outside the
 * message's value space, or the header is not an extended, user-defined,
 * slot-3 message: the message is not this one. */
export function decodeBme280Slot3(
  callsign: string, grid: string, powerDbm: number,
): Bme280Telemetry {
  let n = callsignValue(callsign) * GRID_POWER_FIELD_VALUES + gridPowerValue(grid, powerDbm);
  if (n >= BME280_MESSAGE_VALUES) {
    throw new DecodeError(
      `value ${n} outside the BME280 message space: ${callsign} ${grid} ${powerDbm}`);
  }

  const header: number[] = [];
  for (const radix of EXTENDED_HEADER_RADICES) {
    header.push(n % radix);
    n = Math.floor(n / radix);
  }
  const [telemetryType, reserved, hdrType, slot] = header as [number, number, number, number];
  if (telemetryType !== 0) {
    throw new DecodeError(`not extended telemetry (HdrTelemetryType ${telemetryType}): ${callsign}`);
  }
  if (reserved !== 0 || hdrType !== 0) {
    throw new DecodeError(
      `not a user-defined message (reserved ${reserved}, type ${hdrType}): ${callsign}`);
  }
  if (slot !== BME280_SLOT) {
    throw new DecodeError(`slot ${slot}, not slot ${BME280_SLOT}: ${callsign}`);
  }

  const fields: number[] = [];
  for (const radix of BME280_RADICES) {
    fields.push(n % radix);
    n = Math.floor(n / radix);
  }
  const [temperatureIndex, pressureHpa, humidityPct] = fields as [number, number, number];
  return {
    temperatureC: BME280_TEMPERATURE_LOW_C + temperatureIndex,
    pressureHpa,
    humidityPct,
  };
}
