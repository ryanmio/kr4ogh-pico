/** Verify the browser decoder against the frozen test vectors.
 *
 * tool/tests/vectors/basic_telemetry.json is one full UTC day of a real
 * flight, whose 67 expected rows were verified row-by-row against the
 * Traquito Flight Search Dashboard (see docs/decode-status.md).
 * tool/tests/vectors/petrel_slot3.json is ninety minutes of the first
 * Petrel flight, where the tracker's BME280 reading rides on every fix as
 * extended telemetry in slot 3, cross-checked against an independent
 * decoder. The Python passes both; this asserts the TypeScript port
 * produces byte-identical output from the same input, so "the port is
 * correct" is a measurement rather than a claim.
 *
 * Run:  npx tsx dev/verify-port.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { channel20m, slotMinute } from "../src/lib/wspr/channels";
import { BME280_SLOT } from "../src/lib/wspr/decode";
import { decodeWindow, MATCHER_NAME, MATCHER_VERSION } from "../src/lib/wspr/track";
import type { Spot } from "../src/lib/wspr/query";

const here = dirname(fileURLToPath(import.meta.url));

interface Vector {
  description: string;
  flight: { callsign: string; channel: number; sensor?: string | null };
  raw_spots: Spot[];
  expected_telemetry: Record<string, unknown>[];
  expected_ghosts?: { utc: string; grid4: string; rx_station_count: number }[];
}

// Left side is the site's TrackPoint field, right side the vector's
// (Python) name. They differ only for speed: the site has always called it
// speed_kt, the decoder speed_knots. The sensor fields are absent on a
// point without a reading where the Python row holds null.
const FIELDS: [string, string][] = [
  ["utc", "utc"], ["grid6", "grid6"], ["lat", "lat"], ["lon", "lon"],
  ["altitude_m", "altitude_m"], ["speed_kt", "speed_knots"],
  ["voltage_v", "voltage_v"], ["temperature_c", "temperature_c"],
  ["gps_valid", "gps_valid"], ["rx_station_count", "rx_station_count"],
  ["pressure_hpa", "pressure_hpa"], ["board_temp_c", "board_temp_c"],
  ["humidity_pct", "humidity_pct"],
];

let failures = 0;
const fail = (msg: string) => { console.error(`  FAIL ${msg}`); failures++; };

function verify(file: string, wantGhosts: { utc: string; grid4: string; rx: number }[]) {
  const vector = JSON.parse(readFileSync(join(here, "../tool/tests/vectors", file), "utf8")) as Vector;
  const ch = channel20m(vector.flight.channel);
  const spots = vector.raw_spots;
  const minute = (s: Spot) => Number(s.time.slice(14, 16)) % 10;
  const candidate = (s: Spot) =>
    s.tx_sign.length === 6 && s.tx_sign[0] === ch.id13[0] && s.tx_sign[2] === ch.id13[1];

  // Split the raw spots exactly as the ingest queries would have: Regular
  // spots are the flight's own callsign in the start minute; telemetry
  // candidates are 6-char calls carrying this channel's id13 in characters
  // 1 and 3, in the telemetry minute; sensor candidates the same in slot
  // 3's minute, and only for a flight that declares the sensor.
  const regular = spots.filter((s) =>
    s.tx_sign === vector.flight.callsign && minute(s) === ch.startMinute);
  const telemetry = spots.filter((s) => candidate(s) && minute(s) === ch.telemetryMinute);
  const sensor = vector.flight.sensor === "bme280"
    ? spots.filter((s) => candidate(s) && minute(s) === slotMinute(ch, BME280_SLOT))
    : [];

  const { track: got, ghosts } = decodeWindow(regular, telemetry, sensor);
  const want = vector.expected_telemetry;

  console.log(`vector: ${vector.description.slice(0, 72)}...`);
  console.log(`input:  ${spots.length} raw spots -> ${regular.length} regular, `
    + `${telemetry.length} telemetry candidates, ${sensor.length} sensor candidates`);
  console.log(`output: ${got.length} decoded rows, expected ${want.length}`);

  if (got.length !== want.length) fail(`row count ${got.length} != ${want.length}`);

  for (let i = 0; i < Math.min(got.length, want.length); i++) {
    for (const [mine, theirs] of FIELDS) {
      const a = (got[i] as unknown as Record<string, unknown>)[mine];
      // The Python stores gps_valid as 0/1 in SQLite, and a missing sensor
      // reading as null; compare by value.
      let b = want[i]![theirs];
      if (theirs === "gps_valid") b = Boolean(b);
      if (b === null) b = undefined;
      if (a !== b) fail(`row ${i} (${want[i]!.utc}) field ${mine}: got ${a}, want ${b}`);
    }
  }

  const gotGhosts = ghosts.map((g) => ({ utc: g.utc, grid4: g.grid4, rx: g.rx_station_count }));
  if (JSON.stringify(gotGhosts) !== JSON.stringify(wantGhosts)) {
    fail(`ghosts: got ${JSON.stringify(gotGhosts)}, want ${JSON.stringify(wantGhosts)}`);
  }
  const readings = got.filter((p) => p.pressure_hpa !== undefined).length;
  console.log(`        ${readings} rows carry a sensor reading\n`);
  return want;
}

// The verified day's Regular-only slots, as the Python finds them
// (tool/tests/test_vectors.py holds the same list) and as
// docs/decode-status.md counted them against the dashboard.
const basic = verify("basic_telemetry.json", [
  { utc: "2026-08-18 04:44:00", grid4: "AN71", rx: 22 },
  { utc: "2026-08-18 16:54:00", grid4: "BN35", rx: 13 },
]);
const petrel = verify("petrel_slot3.json", []);

if (failures === 0) {
  console.log(`PASS: ${basic.length} + ${petrel.length} rows identical across all `
    + `${FIELDS.length} fields, and the slots heard without telemetry`);
  // The matcher identity is a constant on the port, not a per-row field.
  console.log(`       matcher ${MATCHER_NAME} v${MATCHER_VERSION}, `
    + `vector says ${basic[0]!.matcher_name} v${basic[0]!.matcher_version}`);
} else {
  console.error(`\n${failures} mismatch(es)`);
  process.exit(1);
}
