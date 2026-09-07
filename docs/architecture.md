# Architecture

## The three-store split

| Store | Role | Holds | Loss tolerance |
|-------|------|-------|----------------|
| SQLite (local, `*.db`) | **The record** | Raw spots (append-only), pull coverage, derived telemetry | None. This is the authoritative flight record. |
| git (this repo) | **The archive and the site's data** | Code, channel table, test vectors, exported flight archives, and the committed track each page ships with | None, but everything in it is reproducible or frozen-by-choice. |
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
  any database. That is the flight-archive export below. It also holds
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

## Flight-archive export (specified here, not yet built)

On flight close (operator action, after `status` flips to `closed`), the tool
writes the full decoded track plus an outcome summary to the site tree:

    /flights/<flight_id>/
        track.json     # full decoded telemetry track
        flight.mdx     # outcome summary page, human-written + generated header

and the operator commits it. Once exported, that flight renders statically
forever and never touches the database again.

`track.json` shape (one object, matching the local `telemetry` table minus
local provenance ids):

    {
      "flight_id": "…",
      "callsign": "…",
      "band": "20m",
      "channel": 0,
      "launch_utc": "…",           // historical fact by export time
      "launch_lat": 0.0,
      "launch_lon": 0.0,
      "status": "closed",
      "close_reason": "…",
      "matcher_name": "…",
      "matcher_version": 0,
      "track": [
        {"utc": "…", "grid6": "…", "lat": 0.0, "lon": 0.0, "altitude_m": 0,
         "speed_kt": 0, "voltage_v": 0.0, "temperature_c": 0,
         "gps_valid": true, "rx_station_count": 0},
        …
      ]
    }

`speed_kt` is what the tracker sent and nothing else. The field saturates at
82 kt (see docs/telemetry-format.md), so on a fast flight it is a floor
rather than a reading, and the site derives the real speed from the distance
flown around each saturated fix. That derivation is deliberately not in this
file: it depends on the fixes either side of a point, and the newest fix — the
one anyone is actually watching — has none after it yet. Storing it would
freeze the worst version of it. `src/lib/speed.ts` recomputes it over
the whole track every time the track changes, in the browser and at build
time alike.

`flight.mdx` carries the narrative: outcome classification (Pass / Fail /
Wounded / Closed per the scoring definitions), dates, distance, and anything
the operator wants to say. Frontmatter references `track.json` so the site can
render the map and charts from static data.

Consequences, and the point of the design:

- Nothing of ours has to be running for the site to be current: live flights
  are decoded in the visitor's browser, closed flights render from git.
- The site's pages have no runtime dependency on any service we operate. The
  scheduled export only affects how much the browser has to fetch to catch
  up, never whether it can.
- git ends up holding the durable archive of every completed flight, next to
  the raw spots in the operator's SQLite file and the frozen test vectors.

Export is deliberately an operator action, not automation: closing a flight
is a judgment call (see the Wounded / Closed definitions), and the export is
a one-shot artifact reviewed in a commit.
