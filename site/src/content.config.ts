import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";

// One directory per archived flight under site/flights/ (see
// docs/architecture.md "Flight-archive export"): flight.mdx is the
// human-written outcome page, track.json the full decoded track. Both are
// committed to git; archived pages never touch a database.
const flights = defineCollection({
  loader: glob({ pattern: "*/flight.mdx", base: "./flights" }),
  schema: z.object({
    flight_id: z.string(),
    title: z.string(),
    // Pass / Fail / Wounded / Closed are the program's scoring definitions;
    // Sample marks archives that are not scored KR4OGH flights.
    outcome: z.enum(["Pass", "Fail", "Wounded", "Closed", "Sample"]),
    summary: z.string(),
    // Human-readable date or date range for the archive card.
    period: z.string(),
  }),
});

export const collections = { flights };
