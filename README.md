# kr4ogh-pico

Live tracking for KR4OGH pico balloon flights: https://kr4ogh-pico.vercel.app

The balloon's payload sends U4B-style WSPR telemetry on 20m. The site queries wspr.live and decodes the telemetry in-browser.

- `site/` — the website. Astro, static output. See `site/README.md`.
- `tool/` — `picolog`, the Python package that ingests and decodes the same
  telemetry into SQLite and exports the track each page ships with. Not the
  liveness path; the browser is.
- `docs/` — wire format, architecture, decode status, partial spots.
