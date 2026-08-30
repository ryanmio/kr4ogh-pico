/** Formatting and derived-stat helpers. Pure functions, used both at build
 * time (archived pages) and in the browser (live pages). All times are UTC —
 * WSPR data is UTC and mixing zones on a telemetry site invites confusion. */

import type { TrackPoint } from "./types";

export function parseUtc(utc: string): Date {
  // Accepts "2026-08-18T00:04:00Z" (archives), "2026-08-18T00:04:00+00:00",
  // and the naive "2026-08-18 00:04:00" the exporter and the browser decoder
  // both produce.
  //
  // The naive form carries no zone, and V8 parses a space-separated datetime
  // as LOCAL time. Left alone, every timestamp on the site would be shifted
  // by whatever offset the visitor's own machine happens to be in. Normalise
  // to explicit UTC before parsing.
  const iso = utc.includes("T") ? utc : utc.replace(" ", "T");
  const zoned = /([Zz]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
  return new Date(zoned);
}

export function fmtUtc(utc: string | Date): string {
  const d = typeof utc === "string" ? parseUtc(utc) : utc;
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function fmtUtcShort(d: Date): string {
  return d.toISOString().slice(5, 16).replace("T", " ");
}

export function fmtRelative(utc: string, now: Date = new Date()): string {
  const ms = now.getTime() - parseUtc(utc).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

/** "6 h 20 m", "2 d 4 h". Coarse on purpose: nobody reading a balloon page
 * needs seconds, and two units is as much as a stat card can carry. */
export function fmtDuration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** Initial great-circle bearing from one point to the next, in degrees from
 * true north. */
export function bearingDeg(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const rad = Math.PI / 180;
  const dLon = (lon2 - lon1) * rad;
  const y = Math.sin(dLon) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
    Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos(dLon);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** A compass point, because "ESE" means something to everyone and "112°"
 * does not. */
export function compassPoint(deg: number): string {
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return points[Math.round(deg / 22.5) % 16]!;
}

const EARTH_RADIUS_KM = 6371;

export function haversineKm(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

export interface TrackStats {
  points: number;
  firstUtc: string;
  lastUtc: string;
  maxAltitudeM: number;
  maxSpeedKt: number;
  distanceKm: number;
  last: TrackPoint;
}

export function trackStats(track: TrackPoint[]): TrackStats | null {
  if (track.length === 0) return null;
  let distanceKm = 0;
  let maxAltitudeM = -Infinity;
  let maxSpeedKt = -Infinity;
  for (let i = 0; i < track.length; i++) {
    const p = track[i]!;
    maxAltitudeM = Math.max(maxAltitudeM, p.altitude_m);
    maxSpeedKt = Math.max(maxSpeedKt, p.speed_kt);
    if (i > 0) {
      const q = track[i - 1]!;
      distanceKm += haversineKm(q.lat, q.lon, p.lat, p.lon);
    }
  }
  return {
    points: track.length,
    firstUtc: track[0]!.utc,
    lastUtc: track[track.length - 1]!.utc,
    maxAltitudeM,
    maxSpeedKt,
    distanceKm,
    last: track[track.length - 1]!,
  };
}
