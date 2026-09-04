/** Verify the browser decoder against the frozen test vector.
 *
 * tool/tests/vectors/basic_telemetry.json is one full UTC day of a real
 * flight, whose 67 expected rows were verified row-by-row against the
 * Traquito Flight Search Dashboard (see docs/decode-status.md). The Python
 * passes it; this asserts the TypeScript port produces byte-identical output
 * from the same input, so "the port is correct" is a measurement rather than
 * a claim.
 *
 * Run:  npx tsx dev/verify-port.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { channel20m } from "../src/lib/wspr/channels";
import { decodeSpots, MATCHER_NAME, MATCHER_VERSION } from "../src/lib/wspr/track";
import type { Spot } from "../src/lib/wspr/query";

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(join(here, "../tool/tests/vectors/basic_telemetry.json"), "utf8"),
);

const ch = channel20m(vector.flight.channel);
const spots: Spot[] = vector.raw_spots;

// Split the raw day exactly as the ingest queries would have: Regular spots
// are the flight's own callsign; telemetry candidates are 6-char calls
// carrying this channel's id13 in characters 1 and 3, in the telemetry minute.
const regular = spots.filter((s) =>
  s.tx_sign === vector.flight.callsign
  && Number(s.time.slice(14, 16)) % 10 === ch.startMinute);
const telemetry = spots.filter((s) =>
  s.tx_sign.length === 6
  && s.tx_sign[0] === ch.id13[0]
  && s.tx_sign[2] === ch.id13[1]
  && Number(s.time.slice(14, 16)) % 10 === ch.telemetryMinute);

const got = decodeSpots(regular, telemetry);
const want = vector.expected_telemetry as Record<string, unknown>[];

// Left side is the site's TrackPoint field, right side the vector's
// (Python) name. They differ only for speed: the site has always called it
// speed_kt, the decoder speed_knots.
const FIELDS: [string, string][] = [
  ["utc", "utc"], ["grid6", "grid6"], ["lat", "lat"], ["lon", "lon"],
  ["altitude_m", "altitude_m"], ["speed_kt", "speed_knots"],
  ["voltage_v", "voltage_v"], ["temperature_c", "temperature_c"],
  ["gps_valid", "gps_valid"], ["rx_station_count", "rx_station_count"],
];

let failures = 0;
const fail = (msg: string) => { console.error(`  FAIL ${msg}`); failures++; };

console.log(`vector: ${vector.description.slice(0, 72)}...`);
console.log(`input:  ${spots.length} raw spots -> ${regular.length} regular, `
  + `${telemetry.length} telemetry candidates`);
console.log(`output: ${got.length} decoded rows, expected ${want.length}\n`);

if (got.length !== want.length) fail(`row count ${got.length} != ${want.length}`);

for (let i = 0; i < Math.min(got.length, want.length); i++) {
  for (const [mine, theirs] of FIELDS) {
    const a = (got[i] as unknown as Record<string, unknown>)[mine];
    // The Python stores gps_valid as 0/1 in SQLite; compare by value.
    const b = theirs === "gps_valid" ? Boolean(want[i][theirs]) : want[i][theirs];
    if (a !== b) fail(`row ${i} (${want[i].utc}) field ${mine}: got ${a}, want ${b}`);
  }
}

if (failures === 0) {
  console.log(`PASS: all ${want.length} rows identical across all ${FIELDS.length} fields`);
  // The matcher identity is a constant on the port, not a per-row field.
  console.log(`       matcher ${MATCHER_NAME} v${MATCHER_VERSION}, `
    + `vector says ${want[0].matcher_name} v${want[0].matcher_version}`);
} else {
  console.error(`\n${failures} mismatch(es)`);
  process.exit(1);
}
