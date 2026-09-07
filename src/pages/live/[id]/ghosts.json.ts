/** A flight's committed ghosts, as a file, beside track.json: the slots the
 * tracker was heard in without its telemetry (lib/types.ts, GhostPoint).
 * Fetched by the home page when `?feature=` names a flight other than the
 * one built into it. */
import type { APIRoute } from "astro";
import { ghostsFor, shownFlights } from "../../../lib/flights";
import type { FlightMeta } from "../../../lib/types";

export function getStaticPaths() {
  return shownFlights().map((flight) => ({
    params: { id: flight.flight_id },
    props: { flight },
  }));
}

export const GET: APIRoute = ({ props }) => {
  const { flight } = props as { flight: FlightMeta };
  return new Response(JSON.stringify(ghostsFor(flight)), {
    headers: { "content-type": "application/json" },
  });
};
