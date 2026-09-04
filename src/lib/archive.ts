/** Build-time access to the git flight archives (flights/<id>/).
 * These are static files committed to the repo; pages built from them have
 * no runtime dependency on any database. */

import { getCollection, type CollectionEntry } from "astro:content";
import type { FlightArchive } from "./types";

const trackModules = import.meta.glob<{ default: FlightArchive }>(
  "../../flights/*/track.json",
  { eager: true },
);

const tracksById = new Map<string, FlightArchive>();
// Held exactly as committed: /flights/<id>/track.json is served from these
// bytes and must stay the record of what the tracker sent. Derived speeds
// (lib/speed.ts) are added by the page that displays a track, not here.
for (const mod of Object.values(trackModules)) {
  tracksById.set(mod.default.flight_id, mod.default);
}

export interface ArchivedFlight {
  entry: CollectionEntry<"flights">;
  archive: FlightArchive;
}

/** Archived flights that have both halves present.
 *
 * A half-present archive is SKIPPED, not thrown on. This used to throw, which
 * meant one inconsistent archive directory failed getStaticPaths and took the
 * entire build down -- including the live flight page, which is the whole
 * point of the site. An archive is optional history; it must never be able to
 * do that.
 *
 * The mismatch is reachable without anyone editing anything: a stale content
 * cache on a build host can hand back a flight.mdx entry for a directory that
 * no longer exists, while the track.json glob is resolved fresh from disk and
 * correctly finds nothing. That is exactly how it failed on Vercel after the
 * VE3VRO sample was removed.
 */
export async function archivedFlights(): Promise<ArchivedFlight[]> {
  const entries = await getCollection("flights");
  const flights = entries.flatMap((entry) => {
    const archive = tracksById.get(entry.data.flight_id);
    if (!archive) {
      console.warn(
        `[archive] skipping ${entry.data.flight_id}: flight.mdx present but ` +
        "no track.json. If the flight was removed, this is a stale content " +
        "cache on the build host and is safe to ignore.",
      );
      return [];
    }
    return [{ entry, archive }];
  });
  // Newest archive first, by last track point.
  return flights.sort((a, b) => {
    const lastOf = (f: ArchivedFlight) =>
      f.archive.track.at(-1)?.utc ?? "";
    return lastOf(b).localeCompare(lastOf(a));
  });
}
