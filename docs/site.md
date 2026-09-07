# The site

The public website for a callsign's pico balloon flights. Astro, static
output, no server and no database. These are the design notes; README.md is
where to start, and "Fly your own" there is how to run it for another
callsign.

## How a live flight reaches the page

1. **Bundled track, instant.** `flights.toml` names the flights and
   `src/data/tracks/<callsign>-<flight_id>.json` holds each one's track, with
   `<callsign>-<flight_id>.ghosts.json` beside it for the slots heard without
   telemetry (`docs/partial-spots.md`); all are in
   git and read at build time (`src/lib/config.ts`, `src/lib/flights.ts`),
   so the stats are in the HTML and the page has its numbers before any
   network round trip.
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

The home page **is** the flight: while something is up, there is nothing to
click through to. With several flights on the site it is built around the
featured one (`[site].featured` in `flights.toml`, else the live flight that
launched first) and switches to another in place when the address says
`?feature=<flight_id>`: the asked-for flight's committed track is fetched
from `/live/<flight_id>/track.json` and the live refresh proceeds from
there. A **Next flight** button walks the flights. `/live/<flight_id>/` is
the permalink for a particular flight and renders the same component.

The view is one flight, but the map can carry others for comparison:
`?overlay=all` (also `overlap=`, `with=`) draws every other shown flight's
track under the featured one in a quieter grey, each with its own named
beacon, and `?overlay=F2A` a particular one. An **All flights** button
writes the former. Overlays are context only -- no cards, no numbers --
and live ones are refreshed from wspr.live alongside the featured flight
(`src/lib/overlay.ts`, the `overlays` option of `map.ts` and `globe.ts`).

A closed flight (`status = "closed"`) is the same view with the clock
stopped: the committed track is final, wspr.live is not asked, and no
weather is offered over a track that is history. Its `end_utc` is also what
tells it apart from a later flight on the same channel under the same
callsign, which to wspr.live is the same signal: every path that pulls or
attributes spots, the tool's pull and decode, the export, and the browser
refresh, is bounded by each flight's launch and end.

Numbers are shown in metric or imperial, the reader's choice, remembered per
browser. The stored track is always metric and always knots; conversion
happens only at display, so there is one representation of the data.

The charts carry a range control — whole flight / ascent / last 24 h —
because a float ruins its own charts: the ascent ends up a couple of percent
of the width and the float a flat line across the rest. Slicing the track
fixes both axes at once, since each chart scales to the values it is handed.
It applies to the charts only: the map always shows the whole flight with the
current position on it, and the stats always describe now. The control hides
itself while a flight is still shorter than six hours, when every range would
show the same thing.

The map fits the whole track and then keeps clear air around the current
position as well. Fitting the track alone puts the balloon hard against the
frame — the newest fix is by definition the end of the line — which leaves
whatever it is flying into off the map. That is the half a reader wants, and
with the weather layer on it is the storm ahead.

What is on screen travels in the link. `?u=i` pins imperial, `?w=c` the
cloud layer, and `?p=speed` the open panel — a card's own name (`journey`,
`altitude`, `speed`, `voltage`, `temperature`, `receivers`), or `status`
(also `signal`), `tracker`, `data`, `about`. Opening a metric's panel colors
the map by it, so the link reproduces both. A link with no `p` opens
nothing, which is what closing a panel leaves behind: an open panel is where
the reader is right now, not a preference, so unlike the units and the
weather layer it is never remembered per browser and never written into the
URL as an explicit emptiness. `?p=none` is accepted anyway, for a link typed
by hand. All three compose: `?u=i&w=c&p=speed`, and `?overlay=` composes
with all of them.

Archived flights are separate and unchanged: `flights/<flight_id>/`
(`flight.mdx` + `track.json`), read at build time, fully static forever.

## Weather on the map

A switch on the live map draws weather under the track. Two layers, because
neither one covers a whole flight:

- **Rain** — the RainViewer radar mosaic, newest frame, about ten minutes
  old. It is built from national radar networks, so it stops a couple of
  hundred km off any coast and is blank for most of an ocean crossing.
- **Clouds** — band 13 infrared (cloud-top temperature) from whichever
  geostationary satellite is nearest the balloon's longitude, via NASA GIBS,
  about forty minutes old. This is the layer that works over open ocean.
  GIBS carries GOES-East, GOES-West and Himawari and nothing over Europe,
  Africa or the Indian Ocean; a flight out there gets the button greyed out
  rather than a layer that draws nothing.

Two things about the infrared are worth knowing before touching it.

**It is already an enhanced product, not a grey picture.** Its colour map is
grey from about +57 °C down to −19 °C and colour below that — cyan, blue,
green, yellow, orange, red, magenta, on past −90 °C. The colours are the
storms. A CSS filter cannot be used to make it transparent, and the attempt
is actively harmful: `grayscale()` turns a red −62 °C top into luminance 43,
and any contrast curve steep enough to clear the warm background then erases
it, keeping the harmless mid-level cloud instead. So `enhance()` in
`weather.ts` computes the alpha per pixel from the data — grey is converted
back to a temperature and fades in as cloud, colour is kept as published —
over a canvas tile layer, which works because GIBS sends CORS headers and so
does not taint the canvas. The one band that is dropped is the warmest
colours, cyan through teal, −19 °C to −32 °C: GIBS starts colouring well
before convection does, and that band otherwise outlines every cloud edge on
the map. Colour therefore starts at green, near −33 °C.

**The frame is pinned, not `default`.** `TIME=default` resolves to whatever
the node answering has finished ingesting, which is not the same answer
twice — two probes seconds apart returned 12:30 and 12:50 — so one map gets
drawn from several moments with a tile-shaped hole wherever one is not ready.
Sampling nine tiles across zooms 3–6 showed frames complete from about 30
minutes old and ragged before that, so `gibsFrameTime()` asks for the newest
ten-minute slot at least 40 minutes back. That is the whole reason the layer
is 40 minutes old rather than 20.

The chosen layer is remembered per browser and can be pinned to a link:
`?w=c` for clouds, `?w=r` for rain, `?w=n` for none, with the long forms
(`?w=clouds`) accepted too. It follows the same rule as `?u=`, and for the
same reason — a link sent because of the storm has to arrive with the storm
on it, so the link outranks the recipient's stored preference, and following
it does not overwrite that preference. The two compose: `?u=i&w=c`.

Both sources are keyless and send `access-control-allow-origin: *`, so this
keeps the site's rule: no proxy, no secrets in the build, nothing of ours
awake. If a source is down the layer does not appear and the map is what it
always was.

Live flights only. An archived flight is months old, and today's weather
drawn over its track would be a picture that lies.

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

## Speeds above 94 mph

The telemetry speed field tops out at 82 knots — 94 mph — and the tracker
clamps rather than rolling over, so a balloon in the jet stream transmits 82
and stays there. That is a floor, not a reading, and taken literally it
flattens the fastest part of every flight into a straight line.

`src/lib/speed.ts` fills those fixes in from the one thing the track knows
that the tracker could not say: where the balloon actually was. It measures
the distance flown over a window centred on each saturated fix, wide enough
(40 minutes) that grid-square quantisation averages out. Below the ceiling
nothing is touched — the tracker's own GPS speed is far better than anything
positions this coarse can give.

Speeds are derived, never stored: the newest fix is the one people are
watching, it arrives with nothing after it to measure against, and its
estimate sharpens as the next reports land. So `track.json` keeps what the
tracker sent and the pass re-runs over the whole track on every refresh.

```sh
npm run speed-check   # accuracy, invariants, and the estimator vs real GPS
```

That flies synthetic balloons at known speeds through the real grid6
quantisation and checks the recovered speed (worst case 6.1 kt at every
bearing), then runs the same estimator over the committed F1B track — which
never saturated, so every fix carries the tracker's own GPS speed as ground
truth. It agrees to 3.5 kt RMS over 86 fixes.

## Run

```sh
npm install
npm run dev            # http://localhost:4321
npm run build          # static output in dist/
npm run live-check     # fetch + decode the live flight in the terminal
npm run speed-check    # derived speeds above the telemetry ceiling
npm run browser-check  # drive the page in Chrome: map draws, survives refresh
```

`npm run browser-check` needs a running dev server and the system Chrome. It
exists because a refresh once blanked the map and nothing in the build or the
typecheck could see it.

`npm run dev` shows real flights immediately: the data is in git, so there is
nothing to configure and no local services to start.

## Refreshing the committed data

From the repo root, against the authoritative SQLite record (the tool
installed per README.md, "Development"):

```sh
python -m picolog.run         --db tool/picolog.db --window-hours 1
python -m picolog.export_site --db tool/picolog.db
```

Both read `flights.toml` at the root by default. The export **merges** into
the committed track, so running it from a short-window database extends a
long flight rather than truncating it. `.github/workflows/ingest.yml` does
exactly this once a day and commits the result, and runs `--from-launch`
whenever `flights.toml` changes, which is what seeds a fresh instance's
track.

## Deploy

Vercel builds the repository root on push to `main`: Astro is detected,
nothing to configure, no secrets. The absolute origin the share cards need
comes from `[site].url` in `flights.toml`, else `SITE_URL`, else the
production host Vercel names for every build (`VERCEL_PROJECT_PRODUCTION_URL`).
`SITE_BASE` exists for a deploy under a subpath and defaults to root.
