# Architecture

## The three-store split

| Store | Role | Holds | Loss tolerance |
|-------|------|-------|----------------|
| SQLite (local, `*.db`) | **The record** | Raw spots (append-only), pull coverage, derived telemetry | None. This is the authoritative flight record. |
| Supabase (Postgres) | **A cache** | Flights metadata + decoded telemetry only | Total. Can be absent, broken, or paused with zero effect on the record. |
| git (this repo) | **The archive** | Code, channel table, test vectors, and exported flight archives | None, but everything in it is reproducible or frozen-by-choice. |

Why three stores rather than one:

- **SQLite is the record** because the mission constraint is "no network, no
  credentials, still correct." Everything derivable (the `telemetry` table)
  can be dropped and rebuilt from raw spots; raw spots are never updated or
  deleted (enforced with triggers). The `pulls` table records what was asked
  of wspr.live and when, which is what lets the tool distinguish "window never
  queried" from "balloon was silent" — the Fail/Wounded scoring depends on
  that distinction.
- **Supabase is a cache** because the public site needs a queryable hot copy
  and nothing else does. The tool only ever writes to it (idempotent upserts,
  never deletes); nothing reads from it. The free tier has zero backup
  retention, which is fine for a cache and disqualifying for a record. No raw
  spots go there: a long flight's raw rows would crowd the 500 MB free tier.
- **git is the archive** because a closed flight should render forever without
  any database. That is the flight-archive export below.

## Flight-archive export (specified here, not yet built)

On flight close (operator action, after `status` flips to `closed`), the tool
writes the full decoded track plus an outcome summary to the site tree:

    /site/flights/<flight_id>/
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

`flight.mdx` carries the narrative: outcome classification (Pass / Fail /
Wounded / Closed per the scoring definitions), dates, distance, and anything
the operator wants to say. Frontmatter references `track.json` so the site can
render the map and charts from static data.

Consequences, and the point of the design:

- The Supabase project can pause between flights (free-tier projects pause
  after inactivity anyway) and nothing breaks: live flights use the cache,
  closed flights use git.
- The site's history pages have no runtime dependency at all.
- git ends up holding the durable archive of every completed flight, next to
  the raw spots in the operator's SQLite file and the frozen test vectors.

Export is deliberately an operator action, not automation: closing a flight
is a judgment call (see the Wounded / Closed definitions), and the export is
a one-shot artifact reviewed in a commit.
