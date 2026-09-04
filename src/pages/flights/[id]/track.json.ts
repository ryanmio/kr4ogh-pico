/** Emits each git flight archive as a static /flights/<id>/track.json asset,
 * fetched by the archived page's map/chart script and offered as a download.
 * Same bytes as flights/<id>/track.json in the repo. */

import type { APIRoute } from "astro";
import { archivedFlights } from "../../../lib/archive";

export async function getStaticPaths() {
  return (await archivedFlights()).map(({ archive }) => ({
    params: { id: archive.flight_id },
    props: { archive },
  }));
}

export const GET: APIRoute = ({ props }) =>
  new Response(JSON.stringify(props.archive, null, 1), {
    headers: { "Content-Type": "application/json" },
  });
