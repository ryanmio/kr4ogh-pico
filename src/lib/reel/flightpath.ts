/** A flight as a function of time, for the reel (lib/reel/scene.ts).
 *
 * The map draws a line; an animation needs to know where along it the
 * balloon was at any instant. This samples the same line the map draws
 * (flightLegs in lib/basemap.ts: great circles between fixes, bent across
 * the nights, routed through the ghosts) at a fixed step in time, so the
 * balloon moves across the screen at the speed it flew: quick in the jet,
 * slow in slack air, and at the one steady speed across a silence that the
 * distance and the hours allow.
 *
 * Positions are unit vectors, x through 0N 0E, y through 0N 90E, z through
 * the pole. Nothing here knows about a camera or a canvas.
 */
import { flightLegs, unwrapLons, type Via } from "../basemap";
import { haversineKm, parseUtc } from "../format";
import { heardUntil, unwrapGhostLons, waypoints } from "../ghosts";
import { groundSpeedKt } from "../speed";
import type { GhostPoint, TrackPoint } from "../types";

export type Vec3 = [number, number, number];

const RAD = Math.PI / 180;
export const EARTH_KM = 6371;
const KM_PER_NM = 1.852;

/** A gap between fixes this long is a silence: the tracker asleep for the
 * night, or out of every receiver's earshot. Inside one the reel says so
 * instead of showing the last numbers as if they were current. */
const SILENCE_MS = 60 * 60 * 1000;

export function unit(lonDeg: number, latDeg: number): Vec3 {
  const lon = lonDeg * RAD;
  const lat = latDeg * RAD;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

export function lonLat(v: Vec3): [number, number] {
  return [Math.atan2(v[1], v[0]) / RAD, Math.atan2(v[2], Math.hypot(v[0], v[1])) / RAD];
}

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export function norm(a: Vec3): Vec3 {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
export function slerp(a: Vec3, b: Vec3, f: number): Vec3 {
  const d = Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
  if (d < 1e-9) return a;
  const s = Math.sin(d);
  return add(scale(a, Math.sin((1 - f) * d) / s), scale(b, Math.sin(f * d) / s));
}
/** Rotate v about the unit axis k by `rad`. */
export function rotate(v: Vec3, k: Vec3, rad: number): Vec3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

/** The unit vector towards the sun at an instant: the point on the ground
 * with the sun overhead. Good to a fraction of a degree, which is a few
 * minutes of dusk; the reel only shades by it. */
export function sunVector(ms: number): Vec3 {
  const d = ms / 86400000 - 10957.5; // days since J2000
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const l = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l));
  const dec = Math.asin(Math.sin(e) * Math.sin(l));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const lon = ra / RAD - gmst * 15;
  return unit(lon, dec / RAD);
}

export interface Sample {
  /** Where the balloon is, on the ground. */
  pos: Vec3;
  /** The way it is travelling, a unit vector tangent to the ground there. */
  heading: Vec3;
  altitudeM: number;
  speedKt: number;
  /** Distance flown so far, counted the way the site's Journey card does. */
  distanceKm: number;
  /** False inside a silence: the numbers are then not readings. */
  heard: boolean;
  temperatureC: number;
}

export interface FlightPath {
  startMs: number;
  endMs: number;
  /** Distance over the whole window. */
  totalKm: number;
  /** The speed the balloon spent the flight at: the median over time. */
  cruiseKt: number;
  peakAltitudeM: number;
  /** The line itself, a point per step of time, and how high it was. */
  count: number;
  pos(i: number): Vec3;
  alt(i: number): number;
  /** The step, as a possibly fractional index, at a time. */
  index(ms: number): number;
  at(ms: number): Sample;
}

interface TimedLeg { fromMs: number; toMs: number; pts: Vec3[]; cum: number[] }

/** The flight between two instants. `fromMs` and `toMs` default to the
 * first and last fix; a window is clamped to them. */
export function buildPath(
  track: TrackPoint[], ghosts: GhostPoint[], spoofed: { utc: string }[] = [],
  window: { fromMs?: number; toMs?: number } = {},
): FlightPath {
  if (track.length < 2) throw new Error("a reel needs a track of at least two fixes");
  const ms = (utc: string) => parseUtc(utc).getTime();
  const fixMs = track.map((p) => ms(p.utc));
  const startMs = Math.max(window.fromMs ?? -Infinity, fixMs[0]!);
  const endMs = Math.min(window.toMs ?? Infinity, fixMs.at(-1)!);
  if (!(endMs > startMs)) throw new Error("the reel's window holds no flight");

  // The line, as the map draws it.
  const lons = unwrapLons(track);
  const way = waypoints(track, ghosts, spoofed);
  const wayLons = unwrapGhostLons(track, lons, way);
  const until = heardUntil(track, ghosts, way);
  const via: Via[] = way.map((g, i) => (
    { utc: g.utc, lat: g.lat, lon: wayLons[i]!, untilUtc: until[i]! }));
  const legs: TimedLeg[] = flightLegs(track, lons, via).map((l) => {
    const pts = l.pts.map(([lon, lat]) => unit(lon!, lat!));
    const cum = [0];
    for (let k = 1; k < pts.length; k++) {
      cum.push(cum[k - 1]! + Math.acos(Math.min(1, dot(pts[k - 1]!, pts[k]!))));
    }
    return { fromMs: ms(l.fromUtc), toMs: ms(l.toUtc), pts, cum };
  });

  // Where on the line at a time: at a steady speed along each stretch, and
  // waiting at a ghost the tracker went on being heard at.
  let li = 0;
  const rawPos = (t: number): Vec3 => {
    while (li < legs.length - 1 && t > legs[li]!.toMs) li++;
    while (li > 0 && t < legs[li]!.fromMs) li--;
    const leg = legs[li]!;
    if (t <= leg.fromMs) return li > 0 && t < leg.fromMs ? legs[li - 1]!.pts.at(-1)! : leg.pts[0]!;
    if (t >= leg.toMs) return leg.pts.at(-1)!;
    const total = leg.cum.at(-1)!;
    const want = total * (t - leg.fromMs) / (leg.toMs - leg.fromMs);
    let k = 1;
    while (k < leg.cum.length - 1 && leg.cum[k]! < want) k++;
    const span = leg.cum[k]! - leg.cum[k - 1]!;
    return slerp(leg.pts[k - 1]!, leg.pts[k]!, span > 0 ? (want - leg.cum[k - 1]!) / span : 0);
  };

  // Distance the way trackStats counts it: fix to fix, and through the
  // waypoints, so the last frame agrees with the site.
  const stops = [
    ...track.map((p, i) => ({ ms: fixMs[i]!, lat: p.lat, lon: p.lon })),
    ...via.map((v) => ({ ms: ms(v.utc), lat: v.lat, lon: v.lon })),
  ].sort((a, b) => a.ms - b.ms);
  const stopKm = [0];
  for (let k = 1; k < stops.length; k++) {
    const a = stops[k - 1]!;
    const b = stops[k]!;
    stopKm.push(stopKm[k - 1]! + haversineKm(a.lat, a.lon, b.lat, b.lon));
  }
  const interp = (xs: number[], ys: number[], x: number): number => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs.at(-1)!) return ys.at(-1)!;
    let lo = 0;
    let hi = xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid]! <= x) lo = mid; else hi = mid;
    }
    const span = xs[hi]! - xs[lo]!;
    return ys[lo]! + (ys[hi]! - ys[lo]!) * (span > 0 ? (x - xs[lo]!) / span : 0);
  };
  const stopMs = stops.map((s) => s.ms);

  // Speed: the tracker's own where it is talking, and across a silence
  // what the distance and the hours come to.
  const speedMs: number[] = [];
  const speedKt: number[] = [];
  for (let i = 0; i < track.length; i++) {
    if (i > 0 && fixMs[i]! - fixMs[i - 1]! >= SILENCE_MS) {
      const km = interp(stopMs, stopKm, fixMs[i]!) - interp(stopMs, stopKm, fixMs[i - 1]!);
      const kt = km / KM_PER_NM / ((fixMs[i]! - fixMs[i - 1]!) / 3600000);
      const edge = 20 * 60 * 1000;
      speedMs.push(fixMs[i - 1]! + edge, fixMs[i]! - edge);
      speedKt.push(kt, kt);
    }
    speedMs.push(fixMs[i]!);
    speedKt.push(groundSpeedKt(track[i]!));
  }
  const altitudes = track.map((p) => p.altitude_m);
  const temps = track.map((p) => p.temperature_c);

  // One point per step. Fine enough that a frame never lands between two
  // far apart; the fixes are ten minutes apart at best.
  const span = endMs - startMs;
  const count = Math.max(600, Math.min(6000, Math.round(span / (4 * 60 * 1000))));
  const step = span / (count - 1);
  const raw: Vec3[] = [];
  const rawAlt: number[] = [];
  const rawSpeed: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = startMs + i * step;
    raw.push(rawPos(t));
    rawAlt.push(interp(fixMs, altitudes, t));
    rawSpeed.push(interp(speedMs, speedKt, t));
  }

  // A fix is the centre of a grid square some 5 km by 7, so the line
  // through them staggers. Twenty minutes of smoothing takes the stagger
  // out and leaves every turn the balloon made; on a long flight it widens
  // so that what is left is still smooth at the speed the reel plays.
  const sigma = Math.max(20 * 60 * 1000, span * 0.004) / step;
  const smooth = <T>(src: T[], mix: (items: T[], weights: number[]) => T, s: number): T[] => {
    const r = Math.ceil(s * 3);
    const kernel: number[] = [];
    for (let k = -r; k <= r; k++) kernel.push(Math.exp(-(k * k) / (2 * s * s)));
    return src.map((_, i) => {
      const items: T[] = [];
      const weights: number[] = [];
      for (let k = -r; k <= r; k++) {
        const j = i + k;
        if (j < 0 || j >= src.length) continue;
        items.push(src[j]!);
        weights.push(kernel[k + r]!);
      }
      return mix(items, weights);
    });
  };
  const mixVec = (items: Vec3[], w: number[]): Vec3 => {
    const r: Vec3 = [0, 0, 0];
    for (let i = 0; i < items.length; i++) {
      r[0] += items[i]![0] * w[i]!; r[1] += items[i]![1] * w[i]!; r[2] += items[i]![2] * w[i]!;
    }
    return norm(r);
  };
  const mixNum = (items: number[], w: number[]): number => {
    let s = 0;
    let t = 0;
    for (let i = 0; i < items.length; i++) { s += items[i]! * w[i]!; t += w[i]!; }
    return s / t;
  };
  const pos = smooth(raw, mixVec, sigma);
  // The ends stay where the flight started and where it is now.
  pos[0] = raw[0]!;
  pos[count - 1] = raw[count - 1]!;
  const alt = smooth(rawAlt, mixNum, sigma / 2);
  const speed = smooth(rawSpeed, mixNum, sigma);

  // Heading, read over a longer baseline than the smoothing, and carried
  // back over a start where the balloon had not yet gone anywhere.
  const reach = Math.max(2, Math.round(sigma * 2));
  const heading: (Vec3 | null)[] = pos.map((p, i) => {
    const a = pos[Math.max(0, i - reach)]!;
    const b = pos[Math.min(count - 1, i + reach)]!;
    const t = sub(b, a);
    const tangent = sub(t, scale(p, dot(p, t)));
    return len(tangent) * EARTH_KM > 3 ? norm(tangent) : null;
  });
  let last: Vec3 | null = heading.find((h) => h) ?? null;
  const east = (p: Vec3): Vec3 => norm(cross([0, 0, 1], p));
  const headingAt = pos.map((p, i) => {
    if (heading[i]) last = heading[i]!;
    const h = last ?? east(p);
    // Carried from elsewhere, it is no longer quite tangent here.
    return norm(sub(h, scale(p, dot(p, h))));
  });
  // Backwards over the start, so the first frames face the way it left.
  for (let i = 0; i < count && !heading[i]; i++) {
    const next = heading.find((h) => h);
    if (next) headingAt[i] = norm(sub(next, scale(pos[i]!, dot(pos[i]!, next))));
  }

  const sortedSpeed = [...speed].sort((a, b) => a - b);
  const startKm = interp(stopMs, stopKm, startMs);
  const index = (t: number) => Math.min(count - 1, Math.max(0, (t - startMs) / step));
  const lerpAt = (xs: number[], f: number) => {
    const i = Math.min(count - 2, Math.floor(f));
    return xs[i]! + (xs[i + 1]! - xs[i]!) * (f - i);
  };

  return {
    startMs,
    endMs,
    totalKm: interp(stopMs, stopKm, endMs) - startKm,
    cruiseKt: sortedSpeed[Math.floor(count / 2)]!,
    peakAltitudeM: Math.max(...alt),
    count,
    pos: (i) => pos[i]!,
    alt: (i) => alt[i]!,
    index,
    at(t) {
      const f = index(t);
      const i = Math.min(count - 2, Math.floor(f));
      const p = norm(add(scale(pos[i]!, 1 - (f - i)), scale(pos[i + 1]!, f - i)));
      const h = add(scale(headingAt[i]!, 1 - (f - i)), scale(headingAt[i + 1]!, f - i));
      // Which fixes the instant falls between, for whether it was heard.
      let k = 0;
      while (k < fixMs.length - 1 && fixMs[k + 1]! <= t) k++;
      const next = fixMs[k + 1];
      const silent = next !== undefined && next - fixMs[k]! >= SILENCE_MS
        && t > fixMs[k]! + 10 * 60 * 1000 && t < next;
      return {
        pos: p,
        heading: norm(sub(h, scale(p, dot(p, h)))),
        altitudeM: lerpAt(alt, f),
        speedKt: lerpAt(speed, f),
        distanceKm: interp(stopMs, stopKm, Math.min(endMs, Math.max(startMs, t))) - startKm,
        heard: !silent,
        temperatureC: interp(fixMs, temps, t),
      };
    },
  };
}
