/** Check the rule that routes the track through ghosts (lib/ghosts.ts,
 * waypoints) and the line drawn from it (lib/basemap.ts, flightPath).
 *
 * A ghost is a grid square, up to 95 km from where the balloon was, and
 * nearly every one sits minutes from a fix that says it far better. The
 * line may only be routed through a ghost when it is the only position
 * there is, so this checks both directions: the ordinary ghosts never move
 * the line, and the ones heard deep in a silence always do.
 *
 * 1. Synthetic: the rule at its edges, case by case.
 * 2. Real: every committed flight. The table is the audit: each ghost the
 *    line is routed through, and how far it is from the fixes either side.
 *    Then the invariants, on every flight: the solid line is the same
 *    points it was before any ghost was involved, wherever no ghost is; a
 *    waypoint is on a dashed run and never on a solid one; the dashed runs
 *    start and end on the solid line or at an end of the flight.
 * 3. Stability: telemetry coming back does not move a dashed stretch that
 *    was already drawn through a waypoint.
 *
 * Run:  npm run waypoint-check
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { flightLine, flightPath, unwrapLons, type Via } from "../src/lib/basemap";
import { haversineKm, parseUtc, trackStats } from "../src/lib/format";
import {
  lineGhosts, unwrapGhostLons, WAYPOINT_GAP_MS, WAYPOINT_MIN_KM, waypoints,
} from "../src/lib/ghosts";
import { believe } from "../src/lib/spoof";
import type { GhostPoint, TrackPoint } from "../src/lib/types";

let failures = 0;
function check(ok: boolean, what: string): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
}

const utc = (h: number) =>
  new Date(Date.UTC(2026, 0, 1) + h * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
const fix = (h: number, lat: number, lon: number) => ({
  utc: utc(h), grid6: "", lat, lon, altitude_m: 12000, speed_kt: 50, voltage_v: 4,
  temperature_c: -30, gps_valid: true, rx_station_count: 5,
}) as TrackPoint;
const ghost = (h: number, lat: number, lon: number): GhostPoint => ({
  utc: utc(h), grid4: `${lat},${lon}`, lat, lon, rx_station_count: 3,
});
const hours = (list: GhostPoint[]) =>
  list.map((g) => (parseUtc(g.utc).getTime() - Date.UTC(2026, 0, 1)) / 3_600_000).join(",");

console.log("1. The rule\n");
{
  // A day of fixes heading east, a silence, and another day of fixes.
  const day1 = [0, 1, 2].map((h) => fix(h, 40, h));
  const day2 = [40, 41, 42].map((h) => fix(h, 40, 30 + (h - 40)));
  const track = [...day1, ...day2];
  const at = (h: number, lat = 42, lon = 15) => waypoints(track, [ghost(h, lat, lon)]).length;
  check(at(3.9) === 0, "a ghost 1.9 h after the last fix is not a waypoint");
  check(at(4) === 1, "a ghost 2.0 h after the last fix is");
  check(at(38.1) === 0, "a ghost 1.9 h before the next fix is not");
  check(at(38) === 1, "a ghost 2.0 h before the next fix is");
  check(at(20, 40.5, 3) === 0, "a ghost deep in the silence but one square from the last fix is not");
  check(at(20, 40.5, 29) === 0, "nor one square short of the next fix");
  check(hours(waypoints(track, [ghost(20, 42, 15), ghost(20.5, 42, 15), ghost(21, 42, 15)]))
    === "20", "three ghosts in one square are one waypoint, the first");
  check(hours(waypoints(track, [ghost(10, 42, 9), ghost(20, 43, 15), ghost(30, 42, 22)]))
    === "10,20,30", "three squares across a silence are three waypoints");
  check(hours(waypoints(track, [ghost(10, 42, 9), ghost(10.2, 42.5, 10), ghost(20, 43, 15)]))
    === "10,20", "a ghost a square on from a waypoint is skipped");
  check(waypoints(track, [0.2, 0.5, 1.5, 2.3, 39.5, 40.5, 42.2].map((h) => ghost(h, 41, 20)))
    .length === 0, "ghosts minutes from fixes, however far their square, never are");
  check(hours(waypoints([], [ghost(1, 40, 0), ghost(2, 40, 0), ghost(3, 40, 4)])) === "1,3",
    "with no fix at all, each new square far enough on is a waypoint");

  // The beacon's ghost is on the line whatever the rule says of it.
  const just = [ghost(42.3, 40, 33)];
  check(waypoints(track, just).length === 0 && lineGhosts(track, just).length === 1,
    "the newest ghost after the last fix is on the line though not a waypoint");
  const two = [ghost(46, 42, 40), ghost(46.2, 42, 40)];
  check(hours(lineGhosts(track, two)) === "46", "but not twice for one square");
  const then = [...track, fix(42.4, 40, 33.2)];
  check(lineGhosts(then, just).length === 0, "and is off the line once its fix arrives");
  check(WAYPOINT_GAP_MS === 2 * 3_600_000 && WAYPOINT_MIN_KM === 150, "2 h and 150 km");
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/data/tracks");
const key = (p: number[]) => `${p[0]!.toFixed(6)},${p[1]!.toFixed(6)}`;

interface Drawn { track: TrackPoint[]; ghosts: GhostPoint[]; way: GhostPoint[]; via: Via[] }
function drawn(track: TrackPoint[], ghosts: GhostPoint[]): Drawn & ReturnType<typeof flightPath> {
  const lons = unwrapLons(track);
  const ghostLons = unwrapGhostLons(track, lons, ghosts);
  const way = lineGhosts(track, ghosts);
  const via = way.map((g) => ({ utc: g.utc, lat: g.lat, lon: ghostLons[ghosts.indexOf(g)]! }));
  return { track, ghosts, way, via, ...flightPath(track, lons, via) };
}

console.log("\n2. Every committed flight\n");
const flights = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.includes(".ghosts")).sort();
for (const f of flights) {
  const id = f.replace(".json", "");
  const gf = join(dir, `${id}.ghosts.json`);
  const { track, ghosts } = believe(
    JSON.parse(readFileSync(join(dir, f), "utf8")) as TrackPoint[],
    existsSync(gf) ? JSON.parse(readFileSync(gf, "utf8")) as GhostPoint[] : []);
  const d = drawn(track, ghosts);
  const rule = waypoints(track, ghosts);
  console.log(`${id}: ${track.length} fixes, ${ghosts.length} ghosts, `
    + `${rule.length} waypoint${rule.length === 1 ? "" : "s"}`
    + (d.way.length > rule.length ? ", and the beacon's ghost" : ""));
  for (const g of d.way) {
    const before = track.filter((p) => p.utc < g.utc).at(-1);
    const after = track.find((p) => p.utc > g.utc);
    const gap = (p: TrackPoint | undefined) => p === undefined ? "none".padStart(16)
      : `${(Math.abs(parseUtc(p.utc).getTime() - parseUtc(g.utc).getTime()) / 3_600_000)
        .toFixed(1).padStart(5)} h ${haversineKm(p.lat, p.lon, g.lat, g.lon).toFixed(0).padStart(5)} km`;
    console.log(`     ${g.utc} ${g.grid4}  fix before ${gap(before)}   fix after ${gap(after)}`
      + (rule.includes(g) ? "" : "   (beacon)"));
  }

  const lons = unwrapLons(track);
  const whole = flightLine(track, lons);
  const solidPts = new Set(d.solid.flat().map(key));
  const coarsePts = new Set(d.coarse.flat().map(key));
  // A hole the line is routed through no longer has its fix-to-fix guess;
  // every other point of the old line must still be there, solid.
  const holes = track.flatMap((p, i) => i > 0
    && d.way.some((g) => g.utc > track[i - 1]!.utc && g.utc < p.utc) ? [i] : []);
  const old = new Set<string>();
  // Rebuilt leg by leg from the whole line: the points between fix i-1 and
  // fix i are the ones flightLine put between those two vertices.
  let v = 0;
  const vertexAt: number[] = [];
  for (let k = 0; k < whole.length && v < track.length; k++) {
    if (key(whole[k]!) === key([lons[v]!, track[v]!.lat])) vertexAt[v++] = k;
  }
  for (let i = 1; i < track.length; i++) {
    if (holes.includes(i)) continue;
    for (let k = vertexAt[i - 1]!; k <= vertexAt[i]!; k++) old.add(key(whole[k]!));
  }
  check(v === track.length, "every fix is a vertex of the fix-only line");
  check([...old].every((k) => solidPts.has(k)),
    `the solid line keeps every point it had outside ${holes.length} routed silence`
    + `${holes.length === 1 ? "" : "s"} (${old.size} points)`);
  check(solidPts.size === old.size || track.length < 2,
    "and has no point it did not have");
  check(track.every((p, i) => track.length < 2 || solidPts.has(key([lons[i]!, p.lat]))
    || (holes.includes(i) && holes.includes(i + 1))),
    "every fix is on the solid line");
  check(d.via.every((w) => coarsePts.has(key([w.lon, w.lat]))) || d.via.length + track.length < 2,
    "every ghost on the line is on a dashed run");
  check(d.via.every((w) => !solidPts.has(key([w.lon, w.lat]))),
    "and none is on the solid line");
  const ends = new Set([
    ...track.map((p, i) => key([lons[i]!, p.lat])),
    ...d.via.map((w) => key([w.lon, w.lat])),
  ]);
  check(d.coarse.every((run) => ends.has(key(run[0]!)) && ends.has(key(run.at(-1)!))
    && [run[0]!, run.at(-1)!].every((p) => solidPts.has(key(p)) || coarsePts.has(key(p)))),
    "every dashed run starts and ends on a fix or a ghost");
  if (!d.way.length) {
    check(d.coarse.length === 0 && d.solid.length <= 1
      && JSON.stringify(d.solid[0] ?? []) === JSON.stringify(track.length > 1 ? whole : []),
      "no ghost on the line: one solid run, point for point the fix-only line");
  }
  const plain = trackStats(track)?.distanceKm ?? 0;
  const routed = trackStats(track, rule)?.distanceKm ?? 0;
  check(routed >= plain - 1e-6 && (rule.length > 0 || routed === plain),
    `distance ${plain.toFixed(0)} km by the fixes, ${routed.toFixed(0)} km through the waypoints`);
  console.log();
}

console.log("3. Telemetry coming back\n");
{
  // PT-02 as it stood on the evening of 19 Nov 2026: a last fix the day
  // before, and two ghosts since. Fly it on and bring the fixes back.
  const id = flights.map((f) => f.replace(".json", "")).find((n) => n.endsWith("PT02"));
  const all = id ? believe(
    JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as TrackPoint[],
    JSON.parse(readFileSync(join(dir, `${id}.ghosts.json`), "utf8")) as GhostPoint[])
    : { track: [], ghosts: [] };
  const track = all.track.filter((p) => p.utc <= "2026-11-18 20:24:00");
  const ghosts = all.ghosts.filter((g) => g.utc <= "2026-11-19 19:04:00");
  const before = drawn(track, ghosts);
  const trailing = track.length
    ? waypoints(track, ghosts).filter((g) => g.utc > track.at(-1)!.utc) : [];
  if (!id) {
    console.log("  (no PT02 among the committed tracks; nothing to replay)");
  } else {
    check(trailing.map((g) => g.grid4).join(",") === "BO56,CO45",
      "PT-02 on the evening of 19 Nov ends on its two waypoints, BO56 and CO45");
    const last = trailing.at(-1)!;
    const t = parseUtc(last.utc).getTime();
    const later = (h: number, dLon: number) => ({
      ...track.at(-1)!,
      utc: new Date(t + h * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
      lat: last.lat - 1, lon: last.lon + dLon,
    });
    const back = [...track, later(24, 12), later(24.2, 12.3), later(24.4, 12.6)];
    const after = drawn(back, ghosts);
    check(trailing.every((g) => after.way.includes(g)),
      `a fix a day later keeps all ${trailing.length} trailing waypoints on the line`);
    const coarse = new Set(after.coarse.flat().map(key));
    // Every dashed point up to the last-but-one waypoint is untouched: the
    // new fix only reshapes the stretch into the waypoint next to it.
    const fixed = before.coarse.flat().slice(0, trailing.length > 1
      ? before.coarse.flat().findIndex((p) => key(p) === key([before.via.at(-2)!.lon, before.via.at(-2)!.lat])) + 1
      : 1);
    check(fixed.every((p) => coarse.has(key(p))),
      `the dashed stretch already drawn does not move (${fixed.length} points)`);
    check(after.solid.length === before.solid.length + 1,
      "and the solid line starts again at the new fixes, as a run of its own");
    const soon = [...track, later(0.5, 0.4)];
    check(!lineGhosts(soon, ghosts).includes(last),
      "a fix half an hour after the newest ghost takes that ghost off the line");
  }
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
