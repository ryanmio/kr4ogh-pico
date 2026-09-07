/** Fetch and decode the live flight straight from wspr.live, the way the page
 * will, and print timings. Cross-check against the Python for the same window:
 *
 *   npx tsx dev/live-check.ts 6
 *
 * Run:  npx tsx dev/live-check.ts [hours]
 */
import { featuredFlight } from "../src/lib/flights";
import { channel20m } from "../src/lib/wspr/channels";
import { fetchWindow } from "../src/lib/wspr/track";

const hours = Number(process.argv[2] ?? 6);
// The flight the home page shows.
const flight = featuredFlight();
if (!flight) throw new Error("flights.toml has no flight to show");
if (flight.status === "closed") throw new Error(`${flight.flight_id} is closed`);
console.log(`${flight.callsign} ${flight.flight_id}`);
const end = new Date();
const start = new Date(end.getTime() - hours * 3600 * 1000);

const ch = channel20m(flight.channel);
console.log(`channel ${ch.channel}: id13 ${ch.id13}, regular minute ${ch.startMinute}, `
  + `telemetry minute ${ch.telemetryMinute}, ${ch.frequencyHz} Hz`);

const t0 = performance.now();
const { track, ghosts } = await fetchWindow(flight, start, end);
const ms = performance.now() - t0;

console.log(`\nfetch + decode of ${hours} h: ${ms.toFixed(0)} ms, ${track.length} fixes, `
  + `${ghosts.length} heard without telemetry\n`);
for (const p of track.slice(-5)) {
  console.log(`  ${p.utc}  ${p.grid6}  ${String(p.altitude_m).padStart(6)} m  `
    + `${p.voltage_v.toFixed(2)} V  ${String(p.temperature_c).padStart(3)} C  `
    + `${p.rx_station_count} rx`);
}
for (const g of ghosts.slice(-5)) {
  console.log(`  ${g.utc}  ${g.grid4}    (no telemetry)         ${g.rx_station_count} rx`);
}
console.log(`\nJSON for comparison:`);
console.log(JSON.stringify(track.map((p) => [p.utc, p.grid6, p.altitude_m,
  p.speed_kt, p.voltage_v, p.temperature_c, p.rx_station_count])));
