/** The records across the committed tracks, as the site would show them:
 * one line per flight, then who holds what and where. Reads the tracks
 * from disk rather than through lib/flights.ts, which bundles them with
 * import.meta.glob and so only runs under Vite.
 *
 * Run:  npm run records-check
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { configuredFlights } from "../src/lib/config";
import { RECORDS, recordHolders, recordPins, summarize } from "../src/lib/records";
import { resolveTrackSpeeds } from "../src/lib/speed";
import type { GhostPoint, TrackPoint } from "../src/lib/types";

const tracks = join(dirname(fileURLToPath(import.meta.url)), "../src/data/tracks");

// The flights the site shows, in its order (lib/flights.ts, shownFlights).
const shown = configuredFlights
  .filter((f) => f.active !== false || f.status === "closed")
  .sort((a, b) =>
    (a.launch_utc ?? "").localeCompare(b.launch_utc ?? "")
    || a.flight_id.localeCompare(b.flight_id));

const summaries = shown.flatMap((f) => {
  const base = join(tracks, `${f.callsign}-${f.flight_id}`);
  if (!existsSync(`${base}.json`)) return [];
  const track = resolveTrackSpeeds(
    JSON.parse(readFileSync(`${base}.json`, "utf8")) as TrackPoint[]);
  const ghosts = existsSync(`${base}.ghosts.json`)
    ? JSON.parse(readFileSync(`${base}.ghosts.json`, "utf8")) as GhostPoint[]
    : [];
  const s = summarize(f, track, ghosts);
  return s ? [s] : [];
});
const holders = recordHolders(summaries);

console.log(`${summaries.length} of ${shown.length} shown flights have telemetry\n`);
console.table(summaries.map((s) => Object.fromEntries([
  ["flight", s.flight_id],
  ["status", s.status],
  ["fixes", s.points],
  ...RECORDS.map((r) => [
    r.label,
    (holders[r.key] === s ? "* " : "") + r.fmt(s.values[r.key], "metric", s),
  ]),
])));

console.log("\nRecords (* above), and where each was set:");
for (const r of RECORDS) {
  const s = holders[r.key];
  if (!s) continue;
  const at = s.at[r.key];
  console.log(`  ${r.label.padEnd(22)} ${r.fmt(s.values[r.key], "metric", s).padEnd(14)}`
    + ` ${s.flight_id.padEnd(6)} ${at.utc}  ${at.lat.toFixed(2)}, ${at.lon.toFixed(2)}`);
}
const pins = recordPins(holders, "metric");
console.log(`\n${pins.length} pins on the map:`);
for (const p of pins) console.log(`  ${p.flight_id.padEnd(6)} ${p.utc}  ${p.label}`);
