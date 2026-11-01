/** Check the GPS-spoof filter in lib/spoof.ts.
 *
 * 1. The spoof PT01 met over Iran on 2026-11-01, as decoded: two true fixes
 *    over the head of the Gulf, then the tracker reporting 33.5 N 48.1 E at
 *    200 m and 0 kt while its BME280 read 250 hPa, a balloon at float. The
 *    first spoofed fix carries that reading; the second has none and must
 *    be caught by distance alone. A true fix after the spoof must be taken
 *    back, and a ghost in the spoofer's square dropped.
 * 2. Every committed track: nothing condemned outside a known spoof, so the
 *    filter has not started eating honest flights -- ascents, overnight
 *    silences and the jet stream included.
 *
 * Run:  npx tsx dev/spoof-check.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  believe, dropSpoofedGhosts, pressureAltitudeM, spoofedSince, splitSpoofed,
} from "../src/lib/spoof";
import type { GhostPoint, TrackPoint } from "../src/lib/types";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

function fix(
  utc: string, grid6: string, lat: number, lon: number, altitude_m: number,
  speed_kt: number, pressure_hpa?: number,
): TrackPoint {
  return {
    utc, grid6, lat, lon, altitude_m, speed_kt, voltage_v: 3.9, temperature_c: -10,
    gps_valid: true, rx_station_count: 3,
    ...(pressure_hpa === undefined ? {} : { pressure_hpa, board_temp_c: -5, humidity_pct: 0 }),
  };
}

// ---------- 1. PT01 over Iran ----------

const iran = [
  fix("2026-11-01 11:40:00", "LL49nm", 29.5208, 49.125, 10920, 60),
  fix("2026-11-01 11:50:00", "LL49pl", 29.4792, 49.2917, 10920, 58, 249),
  fix("2026-11-01 12:00:00", "LM43bm", 33.5208, 48.125, 200, 0, 250),
  fix("2026-11-01 12:30:00", "LM43bm", 33.5208, 48.125, 200, 0),
];
const split = splitSpoofed(iran);
check("pressure catches the spoofed fix that carries a reading",
  split.spoofed.some((p) => p.utc === "2026-11-01 12:00:00"),
  `250 hPa is ${Math.round(pressureAltitudeM(250))} m; GPS said 200 m`);
check("distance catches the spoofed fix without one",
  split.spoofed.some((p) => p.utc === "2026-11-01 12:30:00"));
check("the true fixes before the spoof are kept",
  split.track.map((p) => p.utc).join() === "2026-11-01 11:40:00,2026-11-01 11:50:00");
check("a spoof still going on is reported from its first fix",
  spoofedSince(split.track, [], split.spoofed)?.utc === "2026-11-01 12:00:00");

// The balloon two hours on at its true 60 knots, once the spoofer is behind
// it: measured against 11:50, not against the spoofer's square.
const after = splitSpoofed([
  ...iran, fix("2026-11-01 14:00:00", "LL59fl", 29.4792, 50.4583, 10900, 60, 248),
]);
check("the first true fix after the spoof is taken back",
  after.track.at(-1)?.utc === "2026-11-01 14:00:00" && after.spoofed.length === 2);
check("a spoof that has ended is no longer reported",
  spoofedSince(after.track, [], after.spoofed) === null);

const ghosts: GhostPoint[] = [
  { utc: "2026-11-01 12:10:00", grid4: "LM43", lat: 33.5, lon: 49, rx_station_count: 2 },
  { utc: "2026-11-01 13:00:00", grid4: "LL59", lat: 29.5, lon: 51, rx_station_count: 1 },
];
const kept = dropSpoofedGhosts(after.track, after.spoofed, ghosts);
check("a ghost in the spoofer's square is dropped, a true one kept",
  kept.length === 1 && kept[0]!.grid4 === "LL59");

const b = believe(iran, ghosts);
check("believe() leaves no spoofed fix on the track",
  b.track.every((p) => !b.spoofed.includes(p)) && b.spoofed.length === 2);

// ---------- 2. every committed track ----------

// Spoofs seen in real flights, so the committed tracks can carry them and
// still pass: flight id, and the window the spoofing fell in.
const KNOWN_SPOOFS: Record<string, [string, string][]> = {
  PT01: [["2026-11-01 12:00:00", "2026-11-02 00:00:00"]],
};

const tracks = join(dirname(fileURLToPath(import.meta.url)), "../src/data/tracks");
for (const name of readdirSync(tracks).filter((n) => !n.endsWith(".ghosts.json")).sort()) {
  const id = name.replace(/^[^-]+-/, "").replace(/\.json$/, "");
  const track: TrackPoint[] = JSON.parse(readFileSync(join(tracks, name), "utf8"));
  const g: GhostPoint[] = JSON.parse(
    readFileSync(join(tracks, name.replace(/\.json$/, ".ghosts.json")), "utf8"));
  const r = believe(track, g);
  const known = KNOWN_SPOOFS[id] ?? [];
  const inKnown = (utc: string) => known.some(([a, z]) => utc >= a && utc < z);
  const stray = r.spoofed.filter((p) => !inKnown(p.utc));
  const lostGhosts = g.filter((x) => !r.ghosts.includes(x) && !inKnown(x.utc));
  check(`${id}: nothing condemned outside a known spoof`,
    stray.length === 0 && lostGhosts.length === 0,
    `${track.length} fixes, ${r.spoofed.length} spoofed`
      + (stray.length ? `; stray ${stray.map((p) => p.utc).join(", ")}` : "")
      + (lostGhosts.length ? `; ghosts ${lostGhosts.map((x) => x.utc).join(", ")}` : ""));
  check(`${id}: the believed track passes again untouched`,
    splitSpoofed(r.track).track === r.track);
}

process.exit(failures === 0 ? 0 : 1);
