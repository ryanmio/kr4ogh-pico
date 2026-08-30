# site

The public website for KR4OGH pico balloon flights. Astro, static output, no
server and no database.

## How a live flight reaches the page

1. **Bundled track, instant.** `src/data/flights.json` and
   `src/data/tracks/<flight_id>.json` are committed to git and imported at
   build time, so the map, stats and table are in the HTML. The balloon is on
   screen on first paint, with no network round trip and no spinner. The stats
   and table render even with JavaScript off.
2. **Live tail, about a second later.** The page then queries
   [wspr.live](https://wspr.live/) directly from the browser for anything
   newer than the bundled track, decodes it in place, and merges. wspr.live
   sends `access-control-allow-origin: *`, so this needs no proxy.

The page refreshes every two minutes, on the Refresh button, and whenever a
backgrounded tab becomes visible again.

Consequences worth knowing:

- **Nothing of ours has to be awake.** No cron, no cache, no laptop. The site
  is current because the visitor's browser asks the source.
- **The committed track being stale is cosmetic, never wrong.** A visitor
  always ends up with the newest fixes; a stale export only means the browser
  fetches a slightly wider window to catch up.
- **wspr.live being down is survivable.** The bundled track still renders and
  the page says when it was last updated.
- **No credentials anywhere.** The build takes no secrets and the page
  publishes no API key.

How current is it, really? The tracker sends one telemetry fix per 10-minute
cycle, and receivers take 2-3 minutes to decode and upload, so the newest fix
in existence is 3-13 minutes old. The page shows that fix. Nothing can do
better, including Traquito's own dashboard.

Archived flights are separate and unchanged: `flights/<flight_id>/`
(`flight.mdx` + `track.json`), read at build time, fully static forever.

## The decoder

`src/lib/wspr/` is a TypeScript port of the Python in `tool/picolog/` —
`decode.ts`, `match.ts`, `channels.ts`, `query.ts`, `track.ts`. Both must
agree exactly.

```sh
npm run verify        # 67 rows of the frozen vector, field by field
```

That runs the port over `tool/tests/vectors/basic_telemetry.json`, the same
real flight day the Python is tested against, whose expected output was
verified row-by-row against the Traquito Flight Search Dashboard. Any
divergence between the two implementations fails it.

`src/lib/wspr/channels-20m.json` is generated from the frozen channel table,
never hand-edited:

```sh
npm run gen:channels  # regenerate from tool/picolog/channels_20m.csv
```

## Run

```sh
npm install
npm run dev           # http://localhost:4321
npm run build         # static output in dist/
npm run live-check    # fetch + decode the live flight in the terminal
```

`npm run dev` shows real flights immediately: the data is in git, so there is
nothing to configure and no local services to start.

## Refreshing the committed data

From the repo root, against the authoritative SQLite record:

```sh
cd tool
python -m picolog.run         --flights flights.toml --db picolog.db --window-hours 1
python -m picolog.export_site --flights flights.toml --db picolog.db --site ../site
```

The export **merges** into the committed track, so running it from a
short-window database extends a long flight rather than truncating it.
`.github/workflows/ingest.yml` does exactly this every 30 minutes and commits
the result.

## Deploy

`.github/workflows/site.yml` builds and deploys to GitHub Pages on push to
`main` once Pages is enabled (source: GitHub Actions). `SITE_URL` /
`SITE_BASE` are derived from the Pages configuration. No other configuration
is required.
