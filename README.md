# kr4ogh-pico

Telemetry data layer and public site for KR4OGH pico balloon flights: WSPR
U4B-style telemetry ingest, decode, storage, and display. Monorepo: `/tool`
(Python package `picolog`), `/docs` (format spec, architecture, status),
`/site` (the website — see `site/README.md`).

## Run

```sh
cd tool
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/python -m pytest                       # no network needed
.venv/bin/python -m picolog.run --flights flights.toml --db picolog.db
```

The runner pulls the last hour (`--window-hours` to change) of spots for every
active flight in `flights.toml` from wspr.live and decodes them.
`picolog.export_site` then writes the site's committed flight data:

```sh
.venv/bin/python -m picolog.export_site --flights flights.toml --db picolog.db --site ../site
```

A scheduled workflow (`.github/workflows/ingest.yml`) runs both once a day
and commits the result. That schedule is not load-bearing: the site stays
current regardless, because the visitor's browser queries wspr.live itself
and decodes the telemetry in place, with its own TypeScript port of the
decoder in `site/src/lib/wspr/`. All the export has to do is keep the
committed track fresh enough that the browser's catch-up window still
reaches it, which is a question of days. It ran every 30 minutes when the
site depended on a cache.

## Where the data goes

- **SQLite** (the `--db` file) — the authoritative flight record: raw spots
  (append-only), query coverage, decoded telemetry. Keep it.
- **git** — frozen channel table, test vectors, the site's committed flight
  data under `site/src/data/`, and (per `docs/architecture.md`) archived
  tracks of closed flights under `site/flights/`, rendered statically forever.

See `docs/telemetry-format.md` for the wire format and sources,
`docs/decode-status.md` for validation status, and
`docs/partial-spots.md` for the known gap where only one of a fix's two
messages is heard.
