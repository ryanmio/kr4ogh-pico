/** Build-time access to the git flight archives (site/flights/<id>/).
 * These are static files committed to the repo; pages built from them have
 * no runtime dependency on any database. */

import { getCollection, type CollectionEntry } from "astro:content";
import type { FlightArchive } from "./types";

const trackModules = import.meta.glob<{ default: FlightArchive }>(
  "../../flights/*/track.json",
  { eager: true },
);

const tracksById = new Map<string, FlightArchive>();
for (const mod of Object.values(trackModules)) {
  tracksById.set(mod.default.flight_id, mod.default);
}

export interface ArchivedFlight {
  entry: CollectionEntry<"flights">;
  archive: FlightArchive;
}

export async function archivedFlights(): Promise<ArchivedFlight[]> {
  const entries = await getCollection("flights");
  const flights = entries.map((entry) => {
    const archive = tracksById.get(entry.data.flight_id);
    if (!archive) {
      throw new Error(
        `flight archive ${entry.data.flight_id} has flight.mdx but no track.json`,
      );
    }
    return { entry, archive };
  });
  // Newest archive first, by last track point.
  return flights.sort((a, b) => {
    const lastOf = (f: ArchivedFlight) =>
      f.archive.track.at(-1)?.utc ?? "";
    return lastOf(b).localeCompare(lastOf(a));
  });
}

export function archivedFlightIds(): string[] {
  return [...tracksById.keys()];
}
