/** Read-only client for the Supabase cache, used in the browser for live
 * flights only. Plain PostgREST fetches with the anon key — RLS grants anon
 * SELECT and nothing else, and the site never writes.
 *
 * The cache is allowed to be absent, paused, or broken (see
 * docs/architecture.md); every caller must treat failure as a normal state,
 * not an error page. Archived flights never come through here. */

import type { FlightMeta, TrackPoint } from "./types";

const url = import.meta.env.PUBLIC_SUPABASE_URL;
const key = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

export function cacheConfigured(): boolean {
  return Boolean(url && key);
}

async function rest(path: string, extraHeaders: Record<string, string> = {}) {
  const resp = await fetch(`${url!.replace(/\/$/, "")}/rest/v1/${path}`, {
    headers: {
      apikey: key!,
      Authorization: `Bearer ${key!}`,
      ...extraHeaders,
    },
  });
  if (!resp.ok) throw new Error(`cache responded ${resp.status}`);
  return resp;
}

export async function fetchFlights(): Promise<FlightMeta[]> {
  const resp = await rest("flights?select=*&order=flight_id.asc");
  return (await resp.json()) as FlightMeta[];
}

interface TelemetryRow extends TrackPoint {
  flight_id: string;
}

/** Latest telemetry row for one flight, or null if it has none yet. */
export async function fetchLatest(flightId: string): Promise<TrackPoint | null> {
  const resp = await rest(
    `telemetry?select=*&flight_id=eq.${encodeURIComponent(flightId)}` +
      "&order=utc.desc&limit=1",
  );
  const rows = (await resp.json()) as TelemetryRow[];
  return rows[0] ?? null;
}

/** Full track for one flight, oldest first. Supabase caps a single response
 * (default 1000 rows), so page with Range headers until a short page. */
export async function fetchTrack(flightId: string): Promise<TrackPoint[]> {
  const pageSize = 1000;
  const track: TrackPoint[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const resp = await rest(
      `telemetry?select=*&flight_id=eq.${encodeURIComponent(flightId)}` +
        "&order=utc.asc",
      { Range: `${offset}-${offset + pageSize - 1}` },
    );
    const rows = (await resp.json()) as TelemetryRow[];
    track.push(...rows);
    if (rows.length < pageSize) return track;
  }
}
