/** Fetch and decode the live flight straight from wspr.live, the way the page
 * will, and print timings. Cross-check against the Python for the same window:
 *
 *   npx tsx dev/live-check.ts 6
 *
 * Run:  npx tsx dev/live-check.ts [hours]
 */
import { channel20m } from "../src/lib/wspr/channels";
import { fetchTrack } from "../src/lib/wspr/track";

const hours = Number(process.argv[2] ?? 6);
const flight = { callsign: "KR4OGH", band: "20m", channel: 348 };
const end = new Date();
const start = new Date(end.getTime() - hours * 3600 * 1000);

const ch = channel20m(flight.channel);
console.log(`channel ${ch.channel}: id13 ${ch.id13}, regular minute ${ch.startMinute}, `
  + `telemetry minute ${ch.telemetryMinute}, ${ch.frequencyHz} Hz`);

const t0 = performance.now();
const track = await fetchTrack(flight, start, end);
const ms = performance.now() - t0;

console.log(`\nfetch + decode of ${hours} h: ${ms.toFixed(0)} ms, ${track.length} fixes\n`);
for (const p of track.slice(-5)) {
  console.log(`  ${p.utc}  ${p.grid6}  ${String(p.altitude_m).padStart(6)} m  `
    + `${p.voltage_v.toFixed(2)} V  ${String(p.temperature_c).padStart(3)} C  `
    + `${p.rx_station_count} rx`);
}
console.log(`\nJSON for comparison:`);
console.log(JSON.stringify(track.map((p) => [p.utc, p.grid6, p.altitude_m,
  p.speed_knots, p.voltage_v, p.temperature_c, p.rx_station_count])));
