# kr4ogh-pico

**[kr4ogh-pico.vercel.app](https://kr4ogh-pico.vercel.app)** — a live map of
KR4OGH's pico balloon flights.

A pico balloon is amateur radio's smallest space program: a gram-scale solar
tracker under a party-sized superpressure balloon, released into the jet
stream and never recovered. It whispers 20 milliwatts of WSPR, volunteer
stations around the world hear it, and every decode lands in
[wspr.live](https://wspr.live/).

The site queries wspr.live from the visitor's browser and decodes the U4B
telemetry there — position, altitude, speed, voltage, temperature, how many
stations heard it — so nothing of ours has to be awake for the page to be
current, and there is no server, no database and no API key anywhere in it.
Rain radar and infrared cloud tops go under the track. What is on screen
travels in the link: units, weather layer, open panel.

- `site/` — the website. Astro, static output. See `site/README.md`.
- `tool/` — `picolog`, the Python package that ingests and decodes the same
  telemetry into SQLite and exports the track each page ships with. Not the
  liveness path; the browser is.
- `docs/` — `telemetry-format.md` for the wire format, `architecture.md`,
  `decode-status.md`, and `partial-spots.md` for the known gap where only one
  of a fix's two messages is heard.

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
That schedule is not load-bearing — the browser keeps the page current on its
own. All the export has to do is keep the committed track fresh enough that
the browser's three-day catch-up window still reaches it.
