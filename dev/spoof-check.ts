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
  believe, dropSpoofedGhosts, pressureAltitudeM, spoofedSince, spoofHeadline, spoofRuns,
  spoofModeFromSearch, splitSpoofed, urlWithSpoofMode, withHandSpoofed,
} from "../src/lib/spoof";
import { parseConfig } from "../src/lib/config";
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

// What `?spoofing=show` draws: one detour, from the last true fix out to
// the spoofer and back to the first true fix after.
const runs = spoofRuns(after.track, after.spoofed);
check("the spoof is one run, from 11:50 out and back to 14:00",
  runs.length === 1 && runs[0]!.fixes.length === 2
  && after.track[runs[0]!.before!]?.utc === "2026-11-01 11:50:00"
  && after.track[runs[0]!.after!]?.utc === "2026-11-01 14:00:00");
const ongoing = spoofRuns(split.track, split.spoofed);
check("a spoof still going on has no way back yet",
  ongoing.length === 1 && ongoing[0]!.after === null);
check("?spoofing= reads show, normal, and anything else as the default",
  spoofModeFromSearch("?spoofing=show") === "show"
  && spoofModeFromSearch("?u=i&spoofing=Normal") === "normal"
  && spoofModeFromSearch("?spoofing=nonsense") === "hide"
  && spoofModeFromSearch("") === "hide");
check("switching mode keeps the other parameters, and the default leaves none",
  urlWithSpoofMode("https://x/?u=i#a", "show") === "https://x/?u=i&spoofing=show#a"
  && urlWithSpoofMode("https://x/?u=i&spoofing=show", "normal") === "https://x/?u=i&spoofing=normal"
  && urlWithSpoofMode("https://x/?u=i&spoofing=show", "hide") === "https://x/?u=i");
const raw = believe(iran, ghosts, false);
check("with detection off, every fix and ghost is kept as decoded",
  raw.track.length === iran.length && raw.ghosts.length === ghosts.length
  && raw.spoofed.length === 0);

// ---------- 1b. spoofed fixes entered by hand (flights.toml) ----------

// PT-02 over the Black Sea, 2026-11-14: two true fixes, then a report sent
// two minutes off its slot, from Peru at 1,000 m, entered by hand.
const pt02 = [
  fix("2026-11-14 09:44:00", "KN52qt", 42.85, 31.38, 12100, 82),
  fix("2026-11-14 09:54:00", "KN52sv", 42.90, 31.54, 12120, 82),
];
const hand: TrackPoint = {
  ...fix("2026-11-14 11:36:00", "FH17lx", -12.02, -77.04, 1000, 82),
  spoof_note: "clock ran 2 min slow, position faked",
};
const meta = { spoofed: [hand] };
const withHand = believe(withHandSpoofed(pt02, meta), []);
check("a hand-entered fix is set aside, never on the track",
  withHand.spoofed.length === 1 && withHand.spoofed[0] === hand
  && withHand.track.length === 2 && !withHand.track.includes(hand));
// Even where the jump test would pass it: the hand marks it, not distance.
const nearby = { ...hand, grid6: "KN52sw", lat: 42.94, lon: 31.54, altitude_m: 12100 };
check("a hand-entered fix is set aside even when it is within reach",
  believe(withHandSpoofed(pt02, { spoofed: [nearby] }), []).spoofed[0] === nearby);
check("?spoofing=normal leaves a hand-entered fix out, rather than on the track",
  believe(withHandSpoofed(pt02, meta), [], false).track.every((p) => p.spoof_note == null)
  && believe(withHandSpoofed(pt02, meta), [], false).track.length === 2);
check("a decoded fix in the same slot wins over the hand-entered one",
  withHandSpoofed([...pt02, fix("2026-11-14 11:36:00", "KN52tv", 42.9, 31.6, 12100, 82)], meta)
    .filter((p) => p.utc === hand.utc).every((p) => p.spoof_note == null));

const handOngoing = spoofHeadline(withHand.track, [], withHand.spoofed);
check("while nothing newer is believed, the header calls it probable and pins it to its time",
  handOngoing === "probable GPS spoofing around 2026-11-14 11:36 UTC", handOngoing);
const back = believe(withHandSpoofed(
  [...pt02, fix("2026-11-14 14:04:00", "KN63ba", 43.0, 32.0, 12100, 60)], meta), []);
const handAfter = spoofHeadline(back.track, [], back.spoofed);
check("once true fixes return, the header still says around, never since",
  handAfter === "probable GPS spoofing around 2026-11-14 11:36 UTC" && spoofedSince(back.track, [], back.spoofed) === null,
  handAfter);
const detected = believe(iran, ghosts);
check("a detected spoof still going on keeps its \"since\"",
  /^GPS spoofed since \d\d:\d\d$/.test(spoofHeadline(detected.track, [], [...detected.spoofed,
    fix("2026-11-01 23:00:00", "LM53ql", 33.5, 48.1, 200, 0, 250)])));

const toml = (spoofed: string, end = "") => `
[site]
callsign = "N0CALL"
[[flights]]
flight_id = "T1"
callsign = "N0CALL"
band = "20m"
channel = 178
launch_utc = "2026-11-11 15:00:00"
${end}
[[flights.spoofed]]
${spoofed}`;
const good = `utc = "2026-11-14 11:36:00"
grid6 = "FH17lx"
altitude_m = 1000
speed_kt = 82
voltage_v = 4.15
temperature_c = -17
rx_station_count = 17
note = "clock ran 2 min slow, position faked"`;
const rejects = (text: string, why: RegExp) => {
  try {
    parseConfig(text);
    return false;
  } catch (err) {
    return why.test(String(err));
  }
};
const parsed = parseConfig(toml(good)).flights[0]!.spoofed;
check("flights.toml: a good entry parses, placed at its square's centre",
  parsed?.length === 1 && parsed[0]!.grid6 === "FH17lx" && parsed[0]!.spoof_note !== undefined
  && Math.abs(parsed[0]!.lat - -12.02) < 0.01 && Math.abs(parsed[0]!.lon - -77.04) < 0.01);
check("flights.toml: an entry before launch is refused",
  rejects(toml(good.replace("2026-11-14", "2026-11-10")), /outside this flight/));
check("flights.toml: an entry after end_utc is refused",
  rejects(toml(good, 'end_utc = "2026-11-13 00:00:00"'), /outside this flight/));
check("flights.toml: an entry without a note is refused",
  rejects(toml(good.replace(/^note = .*$/m, "")), /note: required/)
  && rejects(toml(good.replace(/^note = .*$/m, 'note = "  "')), /note: required/));
check("flights.toml: a missing field, a bad square or a stray field is refused",
  rejects(toml(good.replace(/^altitude_m = .*$/m, "")), /altitude_m: required/)
  && rejects(toml(good.replace("FH17lx", "FH17")), /grid6/)
  && rejects(toml(`${good}\nlat = -12`), /unknown field/));

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
