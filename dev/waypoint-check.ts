/** Check the rule that routes the track through ghosts (lib/ghosts.ts,
 * waypoints) and the line drawn from it (lib/basemap.ts, flightLine).
 *
 * A ghost is a grid square, up to 95 km from where the balloon was, and
 * nearly every one sits minutes from a fix that says it far better. The
 * track may only be routed through a ghost when it is the only position
 * there is and the fixes either side bear it out. So this checks both
 * directions: the ordinary ghosts never move the line, a ghost that could
 * be a lie never does either, and the ones the fixes confirm always do.
 *
 * 1. The rule at its edges, case by case.
 * 2. Every committed flight. The table is the audit: each ghost the track
 *    is routed through, and how far it is from the fixes either side. Then
 *    the invariants: outside a routed silence the line is point for point
 *    the line through the fixes alone, and no ghost newer than the last
 *    fix is ever a waypoint.
 * 3. PT-02's two days over the Gulf of Alaska, replayed: nothing moves
 *    while the ghosts are the newest reports, and the track runs through
 *    both squares once the fixes come back.
 * 4. The attack. A false square is put at every grid square on Earth, in
 *    every silence of every flight, and every one the rule accepts has to
 *    be inside the corridor the fixes allow. Then the same with a spoofed
 *    fix nearby, where none may be accepted at all.
 *
 * Run:  npm run waypoint-check
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { flightLine, unwrapLons } from "../src/lib/basemap";
import { haversineKm, parseUtc, trackStats } from "../src/lib/format";
import {
  trailingGhosts, unwrapGhostLons, WAYPOINT_GAP_MS, WAYPOINT_MAX_DETOUR, WAYPOINT_MIN_KM,
  waypoints,
} from "../src/lib/ghosts";
import { believe } from "../src/lib/spoof";
import { maidenheadToLatLon } from "../src/lib/wspr/decode";
import type { GhostPoint, TrackPoint } from "../src/lib/types";

let failures = 0;
function check(ok: boolean, what: string): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
}

const T0 = Date.UTC(2026, 0, 1);
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const utc = (h: number) => stamp(T0 + h * 3_600_000);
const fix = (h: number | string, lat: number, lon: number): TrackPoint => ({
  utc: typeof h === "string" ? h : utc(h), grid6: "", lat, lon, altitude_m: 12000, speed_kt: 50,
  voltage_v: 4, temperature_c: -30, gps_valid: true, rx_station_count: 5,
});
const ghost = (h: number | string, lat: number, lon: number): GhostPoint => ({
  utc: typeof h === "string" ? h : utc(h), grid4: `${lat},${lon}`, lat, lon, rx_station_count: 3,
});
const hours = (list: GhostPoint[]) =>
  list.map((g) => (parseUtc(g.utc).getTime() - T0) / 3_600_000).join(",");
const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  haversineKm(a.lat, a.lon, b.lat, b.lon);

console.log("1. The rule\n");
{
  // A day of fixes heading east, a silence, and another day of fixes.
  const day1 = [0, 1, 2].map((h) => fix(h, 40, h));
  const day2 = [40, 41, 42].map((h) => fix(h, 40, 30 + (h - 40)));
  const track = [...day1, ...day2];
  const at = (h: number, lat = 42, lon = 15) => waypoints(track, [ghost(h, lat, lon)]).length;
  check(at(3.9) === 0, "a ghost 1.9 h after the last fix is not a waypoint");
  check(at(4) === 1, "a ghost 2.0 h after the last fix is");
  check(at(38.1, 41, 27) === 0, "a ghost 1.9 h before the next fix is not");
  check(at(38, 41, 27) === 1, "a ghost 2.0 h before the next fix is");
  check(at(20, 40.5, 3) === 0, "a ghost deep in the silence but one square from the last fix is not");
  check(at(20, 40.5, 29) === 0, "nor one square short of the next fix");
  check(hours(waypoints(track, [ghost(20, 42, 15), ghost(20.5, 42, 15), ghost(21, 42, 15)]))
    === "20", "three ghosts in one square are one waypoint, the first");
  check(hours(waypoints(track, [ghost(10, 42, 9), ghost(20, 43, 15), ghost(30, 42, 22)]))
    === "10,20,30", "three squares across a silence are three waypoints");
  check(hours(waypoints(track, [ghost(10, 42, 9), ghost(10.2, 42.5, 10), ghost(20, 43, 15)]))
    === "10,20", "a ghost a square on from a waypoint is skipped");
  check(waypoints(track, [0.2, 0.5, 1.5, 2.3, 39.5, 40.5].map((h) => ghost(h, 41, 20)))
    .length === 0, "ghosts minutes from fixes, however far their square, never are");

  // Only between two fixes.
  check(waypoints(track, [ghost(50, 40, 40), ghost(70, 40, 50)]).length === 0,
    "a ghost newer than the last fix is never a waypoint, however long the silence");
  check(waypoints(track.slice(3), [ghost(10, 40, 15)]).length === 0,
    "nor one older than the first fix");
  check(waypoints([], [ghost(1, 40, 0), ghost(9, 40, 9)]).length === 0,
    "nor any ghost of a flight with no fix at all");

  // Borne out by the fixes either side.
  check(at(20, 58, 15) === 0, "a square 2,000 km off the straight way between the fixes is not");
  check(at(20, 46, 15) === 1, "one 670 km off it, inside the corridor, is");
  check(at(20, -12, -76) === 0, "a square on another continent is not");
  check(at(4, 40, 60) === 0, "nor one out of reach of the fix before it");
  check(waypoints(track, [ghost(20, 43, 14), ghost(20.3, 37, 22)]).length === 0,
    "two squares that cannot both be true: neither is used");

  // No sign of spoofing near the silence.
  const one = [ghost(20, 42, 15)];
  check(waypoints(track, one, [{ utc: utc(12) }]).length === 0,
    "a spoofed fix inside the silence: no waypoint in it");
  check(waypoints(track, one, [{ utc: utc(-3) }]).length === 0
    && waypoints(track, one, [{ utc: utc(45) }]).length === 0,
    "nor with one within 6 h of either end of it");
  check(waypoints(track, one, [{ utc: utc(-7) }, { utc: utc(47) }]).length === 1,
    "one further off than that does not stop it");
  check(WAYPOINT_GAP_MS === 2 * 3_600_000 && WAYPOINT_MIN_KM === 150
    && WAYPOINT_MAX_DETOUR === 1.5, "2 h, 150 km, 1.5 times the straight way");
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/data/tracks");
const key = (p: number[]) => `${p[0]!.toFixed(6)},${p[1]!.toFixed(6)}`;
const load = (id: string) => {
  const gf = join(dir, `${id}.ghosts.json`);
  return believe(
    JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as TrackPoint[],
    existsSync(gf) ? JSON.parse(readFileSync(gf, "utf8")) as GhostPoint[] : []);
};

/** The drawn line and the old one, cut at the fixes. */
function lines(track: TrackPoint[], way: GhostPoint[]) {
  const lons = unwrapLons(track);
  const wayLons = unwrapGhostLons(track, lons, way);
  const via = way.map((g, i) => ({ utc: g.utc, lat: g.lat, lon: wayLons[i]! }));
  const cut = (line: number[][]) => {
    const legs: number[][][] = [];
    let v = 0;
    let from = 0;
    for (let k = 0; k < line.length && v < track.length; k++) {
      if (key(line[k]!) !== key([lons[v]!, track[v]!.lat])) continue;
      if (v > 0) legs.push(line.slice(from, k + 1));
      from = k;
      v++;
    }
    return v === track.length ? legs : null;
  };
  const routed = flightLine(track, lons, via);
  return { via, routed, plain: cut(flightLine(track, lons)), cut: cut(routed) };
}

console.log("\n2. Every committed flight\n");
const ids = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.includes(".ghosts"))
  .map((n) => n.replace(".json", "")).sort();
for (const id of ids) {
  const { track, ghosts, spoofed } = load(id);
  const way = waypoints(track, ghosts, spoofed);
  console.log(`${id}: ${track.length} fixes, ${ghosts.length} ghosts, `
    + `${way.length} waypoint${way.length === 1 ? "" : "s"}`);
  for (const g of way) {
    const before = track.filter((p) => p.utc < g.utc).at(-1)!;
    const after = track.find((p) => p.utc > g.utc)!;
    const gap = (p: TrackPoint) =>
      `${(Math.abs(parseUtc(p.utc).getTime() - parseUtc(g.utc).getTime()) / 3_600_000)
        .toFixed(1).padStart(5)} h ${km(p, g).toFixed(0).padStart(5)} km`;
    console.log(`     ${g.utc} ${g.grid4}  fix before ${gap(before)}   fix after ${gap(after)}`
      + `   ${((km(before, g) + km(g, after)) / km(before, after)).toFixed(2)}x the straight way`);
  }
  const { via, routed, plain, cut } = lines(track, way);
  check(plain !== null && cut !== null && plain.length === cut.length,
    "every fix is a vertex of the line, in order, routed or not");
  const holes = track.flatMap((p, i) => i > 0
    && way.some((g) => g.utc > track[i - 1]!.utc && g.utc < p.utc) ? [i - 1] : []);
  const same = (plain ?? []).filter((leg, i) =>
    JSON.stringify(leg) === JSON.stringify(cut![i])).length;
  check(same === (plain ?? []).length - holes.length,
    `fix to fix the line is point for point the fix-only line, outside ${holes.length} `
    + `routed silence${holes.length === 1 ? "" : "s"} (${same} stretches)`);
  const on = new Set(routed.map(key));
  check(via.every((w) => on.has(key([w.lon, w.lat]))), "every waypoint is on the line");
  check(!way.length || routed.length > 0, "and the line is one unbroken line");
  const tail = trailingGhosts(track, ghosts);
  check(tail.every((g) => !way.includes(g)), `none of ${tail.length} ghosts newer than the `
    + "last fix is a waypoint: the tail is as it was");
  const plainKm = trackStats(track)?.distanceKm ?? 0;
  const routedKm = trackStats(track, way)?.distanceKm ?? 0;
  check(routedKm >= plainKm - 1e-6 && (way.length > 0 || routedKm === plainKm),
    `distance ${plainKm.toFixed(0)} km by the fixes, ${routedKm.toFixed(0)} km through the waypoints`);
  console.log();
}

// PT-02 as it stood on the evening of 19 Nov 2026: a last fix the day
// before and two ghosts since. Then the fixes that came back on the 20th.
const pt02 = ids.find((n) => n.endsWith("PT02"));
const then = pt02 ? load(pt02) : null;
const dusk = then ? {
  track: then.track.filter((p) => p.utc <= "2026-11-18 20:24:00"),
  ghosts: then.ghosts.filter((g) => g.utc <= "2026-11-19 19:04:00"),
} : null;
const back = ["18:34 CN67rn", "18:44 CN67rl", "18:54 CN67sk", "19:04 CN67si"].map((s) => {
  const [hm, grid] = s.split(" ") as [string, string];
  const [lat, lon] = maidenheadToLatLon(grid);
  return fix(`2026-11-20 ${hm}:00`, lat, lon);
});

console.log("3. PT-02 over the Gulf of Alaska\n");
if (!dusk) {
  console.log("  (no PT02 among the committed tracks; nothing to replay)");
} else {
  const { track, ghosts } = dusk;
  check(trailingGhosts(track, ghosts).map((g) => g.grid4).join(",") === "BO56,CO45",
    "on the evening of 19 Nov the two newest reports are ghosts, in BO56 and CO45");
  check(waypoints(track, ghosts).length === 0
    && JSON.stringify(flightLine(track, unwrapLons(track)))
      === JSON.stringify(lines(track, waypoints(track, ghosts)).routed),
    "and while they are, the track does not move: they are the dashed tail");
  const after = [...track, ...back];
  const way = waypoints(after, ghosts);
  check(way.map((g) => g.grid4).join(",") === "BO56,CO45",
    "the fixes of 20 Nov make both squares waypoints");
  const lons = unwrapLons(after);
  const old = flightLine(after, lons);
  const { routed, via } = lines(after, way);
  const near = (line: number[][], w: { lat: number; lon: number }) =>
    Math.min(...line.map((q) => haversineKm(w.lat, w.lon, q[1]!, q[0]!)));
  for (const w of via) {
    const g = way[via.indexOf(w)]!;
    check(near(old, w) > 150 && near(routed, w) < 1e-6,
      `${g.grid4}: the fix-only line passed ${near(old, w).toFixed(0)} km from it, `
      + "the track now passes through it");
  }
  check(waypoints([...track, fix("2026-11-19 19:34:00", 55.2, -130.4)], ghosts)
    .every((g) => g.grid4 !== "CO45"),
    "had a fix come half an hour after CO45, CO45 would not have been one");
}

console.log("\n4. A false square, anywhere on Earth\n");
{
  // Every grid square, as a ghost at the middle of every silence long
  // enough to hold a waypoint, on every flight.
  let silences = 0;
  let tried = 0;
  let taken = 0;
  let outside = 0;
  let worstKm = 0;
  let worst = "";
  let worstShare = 0;
  let withSpoof = 0;
  // How far a point is from the great circle through two others.
  const vec = (p: { lat: number; lon: number }) => {
    const la = p.lat * Math.PI / 180;
    const lo = p.lon * Math.PI / 180;
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  };
  const offLine = (a: TrackPoint, b: TrackPoint, g: GhostPoint) => {
    const [p, q, w] = [vec(a), vec(b), vec(g)] as [number[], number[], number[]];
    const n = [p[1]! * q[2]! - p[2]! * q[1]!, p[2]! * q[0]! - p[0]! * q[2]!,
      p[0]! * q[1]! - p[1]! * q[0]!];
    const len = Math.hypot(n[0]!, n[1]!, n[2]!);
    return Math.abs(Math.asin((n[0]! * w[0]! + n[1]! * w[1]! + n[2]! * w[2]!) / len)) * 6371;
  };
  for (const id of ids) {
    const { track } = load(id);
    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1]!;
      const b = track[i]!;
      const ta = parseUtc(a.utc).getTime();
      const tb = parseUtc(b.utc).getTime();
      if (tb - ta < 2 * WAYPOINT_GAP_MS) continue;
      silences++;
      const mid = stamp(Math.round((ta + tb) / 2 / 60_000) * 60_000);
      const direct = km(a, b);
      for (let lat = -89.5; lat < 90; lat += 1) {
        for (let lon = -179; lon < 180; lon += 2) {
          const g = ghost(mid, lat, lon);
          tried++;
          if (!waypoints(track, [g]).length) continue;
          taken++;
          const round = km(a, g) + km(g, b);
          if (round > WAYPOINT_MAX_DETOUR * direct + 1e-6) outside++;
          const off = offLine(a, b, g);
          if (off > worstKm) {
            worstKm = off;
            worst = `${id}, ${a.utc} to ${b.utc}, fixes ${direct.toFixed(0)} km apart`;
          }
          worstShare = Math.max(worstShare, off / direct);
          if (waypoints(track, [g], [{ utc: mid }]).length) withSpoof++;
        }
      }
    }
  }
  console.log(`  ${silences} silences, ${tried.toLocaleString("en")} false squares tried, `
    + `${taken.toLocaleString("en")} accepted (${(100 * taken / tried).toFixed(2)} %)`);
  check(outside === 0,
    "every one accepted is inside the corridor the fixes either side allow");
  check(withSpoof === 0, "with a spoofed fix heard in the silence, none is accepted");
  console.log(`  the farthest an accepted square is off the straight way: ${worstKm.toFixed(0)} km`
    + ` (${worst})`);
  check(worstShare < 0.6, "and never more than 0.6 of the distance between the two fixes: "
    + `${worstShare.toFixed(2)} at worst`);
  if (dusk) {
    const after = [...dusk.track, ...back];
    const fake = (lat: number, lon: number) =>
      waypoints(after, [...dusk.ghosts.slice(0, -1), ghost("2026-11-19 19:04:00", lat, lon)])
        .some((g) => g.utc === "2026-11-19 19:04:00");
    check(!fake(-12.5, -77), "PT-02's silence: a square in Peru in place of CO45 is refused");
    check(!fake(35.5, 51), "one in Iran is refused");
    check(!fake(39.5, -77), "one back at the launch site is refused");
    check(!fake(64.5, -149), "one 1,000 km north, in the Alaskan interior, is refused");
    check(fake(55.5, -131), "and CO45 itself is taken");
  }
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
