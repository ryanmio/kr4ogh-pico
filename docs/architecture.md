# Architecture

## The three-store split

| Store | Role | Holds | Loss tolerance |
|-------|------|-------|----------------|
| SQLite (local, `*.db`) | **The record** | Raw spots (append-only), pull coverage, derived telemetry | None. This is the authoritative flight record. |
| git (this repo) | **The archive and the site's data** | Code, channel table, test vectors, and the committed track each page ships with | None, but everything in it is reproducible or frozen-by-choice. |
| wspr.live | **The live source** | Every raw spot, queried by the visitor's browser | Total. If it is unreachable the page still renders its committed track. |

Why three stores rather than one:

- **SQLite is the record** because the mission constraint is "no network, no
  credentials, still correct." Everything derivable (the `telemetry` table)
  can be dropped and rebuilt from raw spots; raw spots are never updated or
  deleted (enforced with triggers). The `pulls` table records what was asked
  of wspr.live and when, which is what lets the tool distinguish "window never
  queried" from "balloon was silent" — the Fail/Wounded scoring depends on
  that distinction.
- **git is the archive** because a closed flight should render forever without
  any database. It holds
  `flights.toml`, the flight list the site and the tool both read, and
  `src/data/tracks/`, written by `picolog.export_site`: each flight's decoded
  track, which the site bundles into the page so a visitor sees the balloon
  on first paint with no round trip, and beside it the flight's ghosts, the
  slots heard without telemetry (docs/partial-spots.md).
- **wspr.live is the live source** because a live tracker must not depend on
  anything of ours being awake. The page queries it directly from the
  browser (it sends `access-control-allow-origin: *`) and decodes in place,
  using a TypeScript port of the same decoder, validated row-for-row against
  the same frozen vector (`dev/verify-port.ts`, `npm run verify`). A
  visitor therefore sees the newest fix that exists anywhere, whether or not
  the operator's machine is on and whether or not the scheduled export ran.

There is deliberately no database in the serving path. An earlier design put
a Supabase cache between the tool and the site; it made the site only as
fresh as the last scheduled write (30-45 minutes, since GitHub's cron runs
late), and it required publishing an API key in the page. Querying the source
directly is both fresher and simpler. The sink, its schema and its
credentials have been removed: nothing in this repo now holds a secret.

## Closed flights

A closed flight keeps its page at `/live/<flight_id>/`, built from its
committed track in `src/data/tracks/` exactly as a live one is, and serves
that track raw at `/live/<flight_id>/track.json`. Once the flight is closed
nothing pulls for it again, so the page renders from git alone, forever.

An earlier design called for a separate archive export on close:
`flights/<flight_id>/track.json` plus a hand-written `flight.mdx` outcome
page. It was never built and has been dropped. The committed track already
renders a closed flight with no database, and the site carries no outcome
pages; Pass / Fail / Wounded / Closed are the tool's scoring terms, not site
content.

`speed_kt` in the committed track is what the tracker sent and nothing else.
The field saturates at 82 kt (see docs/telemetry-format.md), so on a fast
flight it is a floor rather than a reading, and the site derives the real
speed from the distance flown around each saturated fix. That derivation is
deliberately not stored: it depends on the fixes either side of a point, and
the newest fix — the one anyone is actually watching — has none after it
yet. Storing it would freeze the worst version of it. `src/lib/speed.ts`
recomputes it over the whole track every time the track changes, in the
browser and at build time alike.
