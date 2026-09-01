# kr4ogh-pico

Live tracking for KR4OGH pico balloon flights: https://kr4ogh-pico.vercel.app

The tracker sends U4B-style WSPR telemetry. Volunteer receivers upload their
decodes to [wspr.live](https://wspr.live/); the site queries wspr.live from
the visitor's browser and decodes the telemetry there, so it runs with no
server, no database and no key.

- `site/` — the website. Astro, static output. See `site/README.md`.
- `tool/` — `picolog`, the Python package that ingests and decodes the same
  telemetry into SQLite and exports the track each page ships with. Not the
  liveness path; the browser is.
- `docs/` — wire format, architecture, decode status, partial spots.

## Run the tool

```sh
cd tool
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/python -m pytest                       # no network needed
.venv/bin/python -m picolog.run --flights flights.toml --db picolog.db
.venv/bin/python -m picolog.export_site --flights flights.toml --db picolog.db --site ../site
```

`run` pulls the last hour (`--window-hours` to change) of spots for every
active flight in `flights.toml` and decodes them. `export_site` merges what
the database holds into the committed track under `site/src/data/`, so a
short window extends a long flight rather than truncating it.

`.github/workflows/ingest.yml` does both once a day and commits the result.
Nothing depends on that schedule; it only keeps the committed track inside
the browser's three-day catch-up window.
