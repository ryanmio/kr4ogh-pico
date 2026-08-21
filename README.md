# kr4ogh-pico

Telemetry data layer and public site for KR4OGH pico balloon flights: WSPR
U4B-style telemetry ingest, decode, storage, and display. Monorepo: `/tool`
(Python package `picolog`), `/docs` (format spec, architecture, status),
`/site` (the website: live flights from the Supabase cache, archived flights
from git — see `site/README.md`), `/supabase` (cache schema).

Trackers fly bone-stock Traquito firmware; nothing in this repo runs on a
balloon, and nothing here is a mission dependency.

## Run

```sh
cd tool
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/python -m pytest                       # no network needed
.venv/bin/python -m picolog.run --flights flights.toml --db picolog.db
```

The runner pulls the last hour (`--window-hours` to change) of spots for every
active flight in `flights.toml` from wspr.live, decodes them, and pushes the
results to Supabase if `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are set
(see `.env.example`). A scheduled workflow (`.github/workflows/ingest.yml`)
runs the same code every 30 minutes.

## Where the data goes

- **SQLite** (the `--db` file) — the authoritative flight record: raw spots
  (append-only), query coverage, decoded telemetry. Keep it.
- **Supabase** — a write-only cache for the public site. Disposable.
- **git** — frozen channel table, test vectors, and (per
  `docs/architecture.md`) archived tracks of closed flights under
  `site/flights/`, which the site renders statically forever.

See `docs/telemetry-format.md` for the wire format and sources,
`docs/decode-status.md` for validation status.
