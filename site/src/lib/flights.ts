/** Build-time access to the committed flight data.
 *
 * site/src/data/ is written by `python -m picolog.export_site` and committed
 * to git (see tool/picolog/export_site.py). Reading it at build time is what
 * lets a flight page ship with its track already in it, so the map is drawn
 * on first paint rather than after a round trip.
 *
 * Nothing here touches a database or a network. A missing or empty data
 * directory is a valid state: the site builds, and the pages say so.
 */
import type { FlightMeta, TrackPoint } from "./types";
import flightsData from "../data/flights.json";

const trackModules = import.meta.glob<{ default: TrackPoint[] }>(
  "../data/tracks/*.json",
  { eager: true },
);

const tracksById = new Map<string, TrackPoint[]>();
for (const [path, mod] of Object.entries(trackModules)) {
  const id = path.split("/").pop()!.replace(/\.json$/, "");
  tracksById.set(id, mod.default);
}

export function allFlights(): FlightMeta[] {
  return flightsData as FlightMeta[];
}

/** Flights still in the air, newest launch first. */
export function liveFlights(): FlightMeta[] {
  return allFlights()
    .filter((f) => f.status === "live")
    .sort((a, b) => (b.launch_utc ?? "").localeCompare(a.launch_utc ?? ""));
}

export function trackFor(flightId: string): TrackPoint[] {
  return tracksById.get(flightId) ?? [];
}
