/** Fetch and decode a flight straight from wspr.live, the way the page
 * will, and print timings. Cross-check against the Python for the same window:
 *
 *   npx tsx dev/live-check.ts 6
 *
 * Run:  npx tsx dev/live-check.ts [hours] [flight_id]
 *
 * With no flight_id it takes the live flight that launched first. A closed
 * flight can be named, and then the window is the last hours it was heard.
 *
 * The flight list comes from lib/config.ts, not lib/flights.ts: flights.ts
 * bundles the committed tracks through import.meta.glob, which only exists
 * under Vite, and this runs under tsx.
 */
import { configuredFlights } from "../src/lib/config";
import { parseUtc } from "../src/lib/format";
import { channel20m } from "../src/lib/wspr/channels";
import { fetchWindow } from "../src/lib/wspr/track";

const hours = Number(process.argv[2] ?? 6);
const wanted = process.argv[3];
const live = configuredFlights
  .filter((f) => f.active !== false && f.status === "live")
  .sort((a, b) => (a.launch_utc ?? "").localeCompare(b.launch_utc ?? ""));
const flight = wanted
  ? configuredFlights.find((f) => f.flight_id === wanted)
  : live[0];
if (!flight) {
  throw new Error(wanted
    ? `flights.toml has no flight ${wanted}`
    : "no flight is live; name one: npx tsx dev/live-check.ts <hours> <flight_id>");
}
console.log(`${flight.callsign} ${flight.flight_id} (${flight.status})`);
// Past the last slot by its telemetry message, which follows two minutes
// later and has to fall inside the window's exclusive end.
const end = flight.status === "closed" && flight.end_utc
  ? new Date(parseUtc(flight.end_utc).getTime() + 4 * 60 * 1000)
  : new Date();
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
