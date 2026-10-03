/** Where the wind takes it next: a float prediction drawn ahead of the
 * balloon.
 *
 * The predictor is Tawhiri, the Cambridge University Spaceflight engine
 * that SondeHub runs. Given a position, an altitude and a time it walks
 * the GFS wind field forward at that altitude and hands back a timed
 * trajectory. That is the same wind an animated wind map draws, turned
 * into the one thing a reader wants from it: where the balloon goes.
 *
 * The service is keyless and answers with `access-control-allow-origin:
 * *`, so it holds to the same rule as the telemetry and the weather: the
 * visitor's browser asks, nothing of ours is in the loop, and if SondeHub
 * is down the line simply is not there.
 *
 * Live flights only. A closed flight's balloon is nowhere, so there is
 * nothing to predict -- unlike the weather layers, which are today's
 * weather whatever the flight's status.
 */

import { parseUtc } from "./format";
import { lastKnown } from "./ghosts";
import type { GhostPoint, TrackPoint } from "./types";

// ---------- the reader's choice ----------

export type ForecastMode = "on" | "off";

const STORAGE_KEY = "pico-forecast";

export function isForecastMode(v: unknown): v is ForecastMode {
  return v === "on" || v === "off";
}

/** The query parameter that pins the line for one link: `?f=n` to hide it,
 * `?f=y` to show it. The long forms are accepted too. */
export const URL_PARAM = "f";

const FROM_URL: Record<string, ForecastMode> = {
  y: "on", yes: "on", on: "on", forecast: "on",
  n: "off", no: "off", off: "off", none: "off",
};

const TO_URL: Record<ForecastMode, string> = { on: "y", off: "n" };

/** Pure and forgiving, like weatherFromSearch: a typo in a shared link
 * still shows the flight. */
export function forecastFromSearch(search: string): ForecastMode | null {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get(URL_PARAM);
  } catch {
    return null;
  }
  if (raw === null) return null;
  return FROM_URL[raw.trim().toLowerCase()] ?? null;
}

/** The link wins, then the browser's memory, then on: the line is one dim
 * dotted stroke, and where the balloon is heading is the question every
 * reader of a live flight has. */
export function resolveForecastMode(
  search: string, fallback: ForecastMode = "on",
): ForecastMode {
  return forecastFromSearch(search) ?? loadForecastMode(fallback);
}

export function urlWithForecast(href: string, mode: ForecastMode): string {
  const url = new URL(href);
  url.searchParams.set(URL_PARAM, TO_URL[mode]);
  return url.toString();
}

export function loadForecastMode(fallback: ForecastMode = "on"): ForecastMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isForecastMode(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function saveForecastMode(mode: ForecastMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* the line still toggles; the choice just is not remembered */
  }
}

// ---------- the prediction ----------

const TAWHIRI = "https://api.v2.sondehub.org/tawhiri";

/** How far ahead of now the line runs. The model window is about eight
 * days from the newest GFS run, but a float prediction is honest for a few
 * days and decoration after that; three keeps the line something a reader
 * can believe. Measured from now, not from the report: a report that is
 * hours old still gets a line three days into the future. */
export const HORIZON_HOURS = 72;

/** Tawhiri's float profile insists on an ascent: the float altitude has to
 * be above the launch altitude, and an ascent rate is required. Once the
 * balloon is level the profile starts this far under its own altitude and
 * climbs at this rate, which makes the ascent stage two seconds long and
 * puts the float at the altitude the tracker reported. */
const ASCENT_M = 10;
const ASCENT_RATE_MPS = 5;

/** What the altitude has to be doing, over the newest half hour of fixes,
 * to count as climbing or coming down. A pico climbs at about half a metre
 * a second; at float it drifts by a few hundredths. Two fixes at least a
 * quarter of an hour apart are needed to say anything. */
const TREND_WINDOW_MS = 30 * 60_000;
const TREND_MIN_SPAN_MS = 15 * 60_000;
const CLIMB_MPS = 0.2;
const DESCENT_MPS = 0.3;

/** The climb the predictor is given: the measured rate within sane bounds,
 * or the typical pico rate when the flight is too young to have one. */
const DEFAULT_CLIMB_MPS = 0.5;
const MAX_CLIMB_MPS = 3;

/** Within this much of the expected float the balloon is treated as there:
 * the last few hundred metres of a climb are slow and make no difference
 * to where the wind takes it. */
const FLOAT_MARGIN_M = 300;

export const FORECAST_ATTRIBUTION =
  'Forecast &copy; <a href="https://sondehub.org/">SondeHub</a> Tawhiri (GFS)';

/** What the line is predicted from: a report, and what the balloon is
 * doing at it. */
export interface ForecastOrigin {
  utc: string;
  lat: number;
  lon: number;
  altitude_m: number;
  /** True when the report is a ghost, so the position is a grid square
   * rather than a fix. */
  coarse: boolean;
  /** Metres per second the balloon is still climbing at, or null once it
   * has levelled off. */
  climb_mps: number | null;
  /** The altitude the line floats at: the flight's expected float while
   * climbing, the reported altitude once level. */
  float_m: number;
}

export interface ForecastPoint {
  /** Same naive UTC form as a TrackPoint, for the same formatters. */
  utc: string;
  lat: number;
  lon: number;
  altitude_m: number;
}

export interface Forecast {
  from: ForecastOrigin;
  /** When the prediction starts: the report itself, or now when the report
   * is older than the model window. */
  startUtc: string;
  /** The trajectory from the start, about every twenty minutes. */
  points: ForecastPoint[];
}

/** Metres per second the altitude is changing over the newest half hour
 * of fixes, or null when there are not two fixes far enough apart to say. */
export function climbRate(track: TrackPoint[]): number | null {
  const last = track.at(-1);
  if (!last) return null;
  const end = parseUtc(last.utc).getTime();
  const recent = track.filter((p) => end - parseUtc(p.utc).getTime() <= TREND_WINDOW_MS);
  const first = recent[0]!;
  const span = end - parseUtc(first.utc).getTime();
  if (span < TREND_MIN_SPAN_MS) return null;
  return (last.altitude_m - first.altitude_m) / (span / 1000);
}

/** The origin for a flight, or null with nothing honest to predict from.
 *
 * Three cases, read off the altitude trend and the flight's expected
 * float (`float_m` in flights.toml):
 *
 * - Coming down faster than a float ever drifts: the flight is ending,
 *   and there is no float to predict. Null.
 * - Well below the expected float and climbing, or too young to tell:
 *   the climb is modelled. The origin is the newest full fix, not a newer
 *   ghost, so the position, altitude and time the climb starts from
 *   belong together; a ghost's square with a fix's altitude from half an
 *   hour earlier would be a position the balloon has left paired with a
 *   height it has long passed. Floating at the reported altitude instead
 *   would be the wrong flight entirely: a balloon at 3 km is in a
 *   different wind from the one it will float in, and a line drawn there
 *   wanders over the continent while the real one crosses an ocean.
 * - Climbing with no expected float to climb to: nothing honest can be
 *   drawn, and nothing is. Null.
 *
 * Otherwise the balloon is level, and the line floats at the altitude of
 * the newest fix from the newest report of any kind: a ghost is the best
 * position there is, and at float the fix's altitude still holds. */
export function forecastOrigin(
  track: TrackPoint[], ghosts: GhostPoint[], expectedFloatM: number | null,
): ForecastOrigin | null {
  const fix = track.at(-1);
  if (!fix) return null;
  const rate = climbRate(track);
  if (rate !== null && rate <= -DESCENT_MPS) return null;
  const belowFloat = expectedFloatM !== null
    && fix.altitude_m < expectedFloatM - FLOAT_MARGIN_M;
  if (belowFloat && (rate === null || rate >= CLIMB_MPS)) {
    return {
      utc: fix.utc, lat: fix.lat, lon: fix.lon, altitude_m: fix.altitude_m,
      coarse: false,
      climb_mps: Math.min(MAX_CLIMB_MPS, Math.max(CLIMB_MPS, rate ?? DEFAULT_CLIMB_MPS)),
      float_m: expectedFloatM!,
    };
  }
  if (rate !== null && rate >= CLIMB_MPS && expectedFloatM === null) return null;
  const known = lastKnown(track, ghosts)!;
  return {
    utc: known.utc, lat: known.lat, lon: known.lon, altitude_m: fix.altitude_m,
    coarse: known.coarse, climb_mps: null, float_m: fix.altitude_m,
  };
}

/** Tawhiri's longitude runs 0 to 360. */
function lon360(lon: number): number {
  return ((lon % 360) + 360) % 360;
}

function lon180(lon: number): number {
  return ((lon + 540) % 360) - 180;
}

/** ISO without milliseconds, which is the form the predictor echoes. */
function isoSeconds(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

/** The predictor's timestamp as the site's naive UTC form. */
function naiveUtc(iso: string): string {
  return iso.slice(0, 19).replace("T", " ");
}

interface TawhiriStage {
  stage: string;
  trajectory: {
    datetime: string; latitude: number; longitude: number; altitude: number;
  }[];
}

class PredictionError extends Error {}

/** One request, from one start time. Throws a PredictionError when the
 * predictor could not run it -- the start outside its window is the usual
 * reason -- and any other Error when the service itself is unreachable. */
async function predict(
  from: ForecastOrigin, start: Date, stop: Date,
): Promise<ForecastPoint[]> {
  // Climbing: the real climb, from the fix to the expected float. Level:
  // the token two-second ascent that puts the float at the reported
  // altitude (a fix at ground level cannot start below zero).
  const climbing = from.climb_mps !== null;
  const launchAlt = climbing
    ? Math.round(from.altitude_m)
    : Math.max(0, Math.round(from.altitude_m) - ASCENT_M);
  const floatAlt = climbing ? Math.round(from.float_m) : launchAlt + ASCENT_M;
  const q = new URLSearchParams({
    profile: "float_profile",
    launch_latitude: from.lat.toFixed(4),
    launch_longitude: lon360(from.lon).toFixed(4),
    launch_altitude: launchAlt.toString(),
    launch_datetime: isoSeconds(start),
    ascent_rate: (climbing ? from.climb_mps! : ASCENT_RATE_MPS).toFixed(2),
    float_altitude: floatAlt.toString(),
    stop_datetime: isoSeconds(stop),
  });
  const r = await fetch(`${TAWHIRI}?${q}`);
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const desc: string = body?.error?.description ?? `HTTP ${r.status}`;
    if (body?.error?.type === "PredictionException") throw new PredictionError(desc);
    throw new Error(desc);
  }
  const stages: TawhiriStage[] = Array.isArray(body?.prediction) ? body.prediction : [];
  return stages.flatMap((s) => s.trajectory ?? []).map((p) => ({
    utc: naiveUtc(p.datetime),
    lat: p.latitude,
    lon: lon180(p.longitude),
    altitude_m: p.altitude,
  }));
}

/** How long one answer is kept. The map is rebuilt every two minutes and
 * must not ask SondeHub each time; half an hour also paces how often a
 * fresh GFS run gets picked up while the balloon is silent. */
const CACHE_MS = 30 * 60 * 1000;

let cached: { key: string; at: number; promise: Promise<Forecast | null> } | null = null;

/** The prediction from an origin, fetched once per origin per half hour.
 *
 * The start is the report itself when the predictor accepts it: overnight
 * the tracker is silent for hours, and running the wind forward from where
 * it was last heard is the best guess of where it is now as well as where
 * it is going. When the report is older than the model window the
 * predictor refuses, and the line is run from now at that position
 * instead, which is honest as long as it is drawn as a guess.
 *
 * Null when the predictor cannot answer at all, cached like a success so
 * a dead service is not retried on every rebuild. The same object comes
 * back for the same origin until the cache turns over, so a caller can
 * compare by identity to learn whether there is anything new to draw. */
export function fetchForecast(
  from: ForecastOrigin, now: number = Date.now(),
): Promise<Forecast | null> {
  const key = [
    from.utc, from.lat, from.lon, from.altitude_m, from.climb_mps, from.float_m,
  ].join("|");
  if (cached && cached.key === key && now - cached.at < CACHE_MS) return cached.promise;
  const stop = new Date(now + HORIZON_HOURS * 3_600_000);
  const promise = (async (): Promise<Forecast | null> => {
    const reported = parseUtc(from.utc);
    const starts = reported.getTime() < now
      ? [reported, new Date(now)]
      : [new Date(now)];
    for (const start of starts) {
      try {
        const points = await predict(from, start, stop);
        if (!points.length) return null;
        return { from, startUtc: naiveUtc(start.toISOString()), points };
      } catch (e) {
        if (!(e instanceof PredictionError)) return null;
      }
    }
    return null;
  })();
  cached = { key, at: now, promise };
  return promise;
}

/** The points a day apart along the line, for the marks that give it a
 * scale: the first point at or past each whole day from the start. */
export function dayMarks(f: Forecast): { point: ForecastPoint; days: number }[] {
  const t0 = parseUtc(f.startUtc).getTime();
  const out: { point: ForecastPoint; days: number }[] = [];
  let days = 1;
  for (const p of f.points) {
    if (parseUtc(p.utc).getTime() - t0 >= days * 86_400_000) {
      out.push({ point: p, days });
      days++;
    }
  }
  return out;
}
