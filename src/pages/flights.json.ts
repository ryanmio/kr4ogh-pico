/** The flight list as a file: flights.toml after lib/config.ts has checked
 * it, with the deploy-time fallbacks resolved. The notifier under notify/
 * reads this, so a fork's Worker follows its flights.toml without being told
 * what is flying; it is also a plain machine-readable copy for anything
 * else. Nothing here is private: the file is in the public repo. */
import type { APIRoute } from "astro";
import { siteConfig } from "../lib/config";
import { allFlights } from "../lib/flights";

export const GET: APIRoute = () =>
  new Response(JSON.stringify({ site: siteConfig, flights: allFlights() }), {
    headers: { "content-type": "application/json" },
  });
