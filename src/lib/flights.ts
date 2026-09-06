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
import { configuredFlights, siteConfig } from "./config";
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

/** Flights on the site: active, or closed and kept. Earliest launch first,
 * then by id, which is also the order the "Next flight" button walks.
 * Mirrors tool/picolog/export_site.py, which keeps the same tracks. */
export function shownFlights(): FlightMeta[] {
  return allFlights()
    .filter((f) => f.active !== false || f.status === "closed")
    .sort((a, b) =>
      (a.launch_utc ?? "").localeCompare(b.launch_utc ?? "")
      || a.flight_id.localeCompare(b.flight_id));
}

/** Flights in the air: shown and not closed. */
export function liveFlights(): FlightMeta[] {
  return shownFlights().filter((f) => f.status === "live");
}

/** The flight the home page shows when the address names none: the one
 * flights.toml features, else the live flight that launched first, else
 * the first shown flight, else nothing. */
export function featuredFlight(): FlightMeta | undefined {
  const shown = shownFlights();
  return shown.find((f) => f.flight_id === siteConfig.featured)
    ?? liveFlights()[0]
    ?? shown[0];
}

/** The committed track for a flight, with speeds above the telemetry
 * ceiling filled in (lib/speed.ts). The estimate is derived here rather than
 * exported into the JSON because it depends on the fixes around each point,
 * and the browser keeps adding those; the same pass runs again on every live
 * refresh. */
export function trackFor(flight: FlightMeta): TrackPoint[] {
  return resolveTrackSpeeds(rawTrackFor(flight));
}

/** The committed track exactly as exported, for /live/<id>/track.json: the
 * record of what the tracker sent, without the derived speeds. */
export function rawTrackFor(flight: FlightMeta): TrackPoint[] {
  return tracksByFile.get(trackFilename(flight)) ?? [];
}
