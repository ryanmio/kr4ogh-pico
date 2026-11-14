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
import { believe, withHandSpoofed, type Believed } from "./spoof";
import type { FlightMeta, GhostPoint, TrackPoint } from "./types";

const trackModules = import.meta.glob<{ default: TrackPoint[] }>(
  ["../data/tracks/*.json", "!../data/tracks/*.ghosts.json"],
  { eager: true },
);
// Beside each track, the slots heard without telemetry (lib/types.ts,
// GhostPoint), written by the same export. Optional: a track exported
// before ghosts existed simply has none.
const ghostModules = import.meta.glob<{ default: GhostPoint[] }>(
  "../data/tracks/*.ghosts.json",
  { eager: true },
);

const tracksByFile = new Map<string, TrackPoint[]>();
for (const [path, mod] of Object.entries(trackModules)) {
  tracksByFile.set(path.split("/").pop()!, mod.default);
}
const ghostsByFile = new Map<string, GhostPoint[]>();
for (const [path, mod] of Object.entries(ghostModules)) {
  ghostsByFile.set(path.split("/").pop()!, mod.default);
}

/** Mirrors tool/picolog/export_site.py. */
function trackFilename(flight: FlightMeta): string {
  return `${flight.callsign}-${flight.flight_id}.json`;
}
function ghostsFilename(flight: FlightMeta): string {
  return `${flight.callsign}-${flight.flight_id}.ghosts.json`;
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
 * the flight that launched last, else nothing. */
export function featuredFlight(): FlightMeta | undefined {
  const shown = shownFlights();
  return shown.find((f) => f.flight_id === siteConfig.featured)
    ?? liveFlights()[0]
    ?? shown.at(-1);
}

/** The committed track and ghosts for a flight as the site shows them:
 * spoofed fixes set aside (lib/spoof.ts) and speeds above the telemetry
 * ceiling filled in (lib/speed.ts). Both are derived here rather than
 * exported into the JSON because they depend on the fixes around each
 * point, and the browser keeps adding those; the same pass runs again on
 * every live refresh. */
export function flightData(flight: FlightMeta): Believed {
  return believe(withHandSpoofed(rawTrackFor(flight), flight), rawGhostsFor(flight));
}

export function trackFor(flight: FlightMeta): TrackPoint[] {
  return flightData(flight).track;
}

export function ghostsFor(flight: FlightMeta): GhostPoint[] {
  return flightData(flight).ghosts;
}

/** The committed track exactly as exported, for /live/<id>/track.json: the
 * record of what the tracker sent, spoofed fixes and all, without the
 * derived speeds. */
export function rawTrackFor(flight: FlightMeta): TrackPoint[] {
  return tracksByFile.get(trackFilename(flight)) ?? [];
}

/** The committed ghosts exactly as exported, for /live/<id>/ghosts.json. */
export function rawGhostsFor(flight: FlightMeta): GhostPoint[] {
  return ghostsByFile.get(ghostsFilename(flight)) ?? [];
}
