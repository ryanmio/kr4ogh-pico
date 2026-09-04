/** Build-time access to the flights and their committed tracks.
 *
 * The flight list is flights.toml (lib/config.ts). Each track under
 * src/data/tracks/<callsign>-<flight_id>.json is written by `python -m
 * picolog.export_site` and committed to git (see tool/picolog/export_site.py,
 * which also says why the callsign is in the name); reading it at build time
 * is what lets a flight page ship with its track already in it, so the map
 * is drawn on first paint rather than after a round trip.
 *
 * Nothing here touches a database or a network. A missing or empty tracks
 * directory is a valid state: the site builds, and the pages say so.
 */
import { configuredFlights } from "./config";
import { resolveTrackSpeeds } from "./speed";
import type { FlightMeta, TrackPoint } from "./types";

const trackModules = import.meta.glob<{ default: TrackPoint[] }>(
  "../data/tracks/*.json",
  { eager: true },
);

const tracksByFile = new Map<string, TrackPoint[]>();
for (const [path, mod] of Object.entries(trackModules)) {
  tracksByFile.set(path.split("/").pop()!, mod.default);
}

/** Mirrors tool/picolog/export_site.py. */
function trackFilename(flight: FlightMeta): string {
  return `${flight.callsign}-${flight.flight_id}.json`;
}

export function allFlights(): FlightMeta[] {
  return configuredFlights;
}

/** Flights in the air: active and not closed, newest launch first. */
export function liveFlights(): FlightMeta[] {
  return allFlights()
    .filter((f) => f.active !== false && f.status === "live")
    .sort((a, b) => (b.launch_utc ?? "").localeCompare(a.launch_utc ?? ""));
}

/** The committed track for a flight, with speeds above the telemetry
 * ceiling filled in (lib/speed.ts). The estimate is derived here rather than
 * exported into the JSON because it depends on the fixes around each point,
 * and the browser keeps adding those; the same pass runs again on every live
 * refresh. */
export function trackFor(flight: FlightMeta): TrackPoint[] {
  return resolveTrackSpeeds(tracksByFile.get(trackFilename(flight)) ?? []);
}
