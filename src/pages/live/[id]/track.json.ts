/** A flight's committed track, as a file: what the home page fetches when
 * `?feature=` names a flight other than the one built into it, and a plain
 * download of the record. The raw export, without derived speeds, the same
 * as /flights/<id>/track.json for an archived flight. */
import type { APIRoute } from "astro";
import { rawTrackFor, shownFlights } from "../../../lib/flights";
import type { FlightMeta } from "../../../lib/types";

export function getStaticPaths() {
  return shownFlights().map((flight) => ({
    params: { id: flight.flight_id },
    props: { flight },
  }));
}

export const GET: APIRoute = ({ props }) => {
  const { flight } = props as { flight: FlightMeta };
  return new Response(JSON.stringify(rawTrackFor(flight)), {
    headers: { "content-type": "application/json" },
  });
};
