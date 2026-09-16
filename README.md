# kr4ogh-pico

A forkable tracking site for pico balloon flights: **https://kr4ogh-pico.vercel.app**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fryanmio%2Fkr4ogh-pico&project-name=my-pico-balloon&repository-name=my-pico-balloon)

The balloon's tracker sends U4B-style WSPR telemetry. Volunteer stations
hear it and upload every decode to [wspr.live](https://wspr.live/); the
site queries that database from the visitor's browser and decodes the
telemetry in place. There is no server, no database and no API key in the
serving path. The page is current because the visitor's browser asks the
source, whether or not anything of yours is switched on.

It is built to be handed to people who are not radio people.

## Fly your own

Ten minute setup with no terminal. You need a GitHub account and a Vercel account
(free; sign in to Vercel with GitHub).

### The fast way: the deploy button

1. Press **Deploy with Vercel** above. Vercel copies this repository into
   your GitHub account and builds it. Give the repository a name like
   `n0call-pico`; the site's address is made from the project name.
2. On GitHub, open your new repository, click `flights.toml`, then the
   pencil. Replace the `[site]` callsign and the `[[flights]]` entries with
   your own. `band` and `channel` are what you configured on the tracker;
   `launch_utc` is when the balloon was first heard, in UTC. The comments
   at the top of the file explain every field. Press **Commit changes**.
3. Two things happen on their own. GitHub Actions fetches your flight's
   history from wspr.live, back to `launch_utc`, and commits it (a minute or
   two; a long flight takes a few more). Vercel rebuilds. Your site is live
   at `https://<project>.vercel.app`, and your balloon is on it.

### Alternative method: fork

A fork keeps a link back to this repository, so when it improves, the
**Sync fork** button on GitHub brings your copy up to date; a copy made by
the deploy button has no such button. The price is two more clicks:

1. **Fork** this repository.
2. Open the **Actions** tab of your fork and press the green button to
   enable workflows. GitHub switches them off in forks until asked.
3. Edit `flights.toml` as above and commit.
4. Go to [vercel.com/new](https://vercel.com/new), import your fork and
   press **Deploy**. Nothing to configure.

### Afterwards, either way

Both ways end in the same place: a repository of your own on GitHub with
`flights.toml` in it, and a Vercel site that rebuilds whenever that
repository changes. From here on there is no difference, and everything
below is done the same way as step 2 above: open `flights.toml` on GitHub,
press the pencil, commit.

- **A new flight** is a new `[[flights]]` entry. Committing the edit is all
  it takes: the history is fetched and the site rebuilds on their own, as
  they did the first time.
- **An old flight** gets `status = "closed"` and an `end_utc`, the time it
  was last heard. It keeps its page and its track, reads as ended, and is
  no longer polled. The end matters most when the next flight reuses the
  channel: to wspr.live the two are one signal, and the end is what keeps
  the new one's telemetry off the old one's track. A launch that failed
  gets `active = false` instead, which takes it off the site.
- **Several flights at once** are several entries. The home page shows one
  of them: `featured = "F2B"` in the `[site]` table picks it, otherwise the
  live flight that launched first. `/?feature=<flight_id>` shows another,
  the **Next flight** button walks them, and every flight also has its own
  address at `/live/<flight_id>/`. To see two at once, the **All flights**
  button draws the others' tracks on the same map (`?overlay=all`, or
  `?overlay=F2A` for a particular one).
- **The track stays fresh by itself.** A daily workflow refreshes the
  committed track; the browser fetches anything newer on every visit. If
  the workflow ever stops (GitHub pauses scheduled workflows in a repository
  that has seen no commits for 60 days), the site is still current, only
  slower on first paint; any commit restarts it. The **Actions** tab can
  also run it by hand, with the option to refetch from launch.
- **Your own domain** is a Vercel project setting; `flights.toml` needs
  nothing for it.
- **Tracker details**, the build facts shown in the Tracker panel, are an
  optional `[flights.tracker]` table under a flight. Any labels you like.

### Alerts on your phone

Optional. A small Cloudflare Worker in `notify/` taps your phone, and your
watch if you wear one, when a flight is heard again after a silence: the
first spot after launch, the first of the morning, landfall after a night
over the sea. It runs on Cloudflare's free plan, asks wspr.live every five
minutes, and reaches you within a few minutes of the spot. The site does
not change and needs none of this.

You need the [ntfy](https://ntfy.sh/) app (free, iPhone and Android) and a
free [Cloudflare](https://dash.cloudflare.com/sign-up) account. This part
does use a terminal.

1. In ntfy, subscribe to a topic. The topic name is the only secret: anyone
   who knows it can subscribe, so make it something nobody would guess,
   like `n0call-pico-7q2xk`.
2. In `notify/wrangler.toml`, set `SITE_URL` to your site's address, and
   commit.
3. In a terminal, from the repository:

   ```sh
   cd notify
   npm install
   npx wrangler login                  # opens the browser
   npx wrangler deploy
   npx wrangler secret put NTFY_TOPIC  # paste the topic name
   ```

4. Within five minutes the phone shows "Watching N0CALL F1", one per live
   flight, which is how you know it works. From then on: "N0CALL F1 heard:
   Heard 12:04 UTC, after 15 h 30 min of silence. GN78gt, 8,640 m, heard by
   14 stations." Tapping it opens the flight on the map.

What it tells you about is set in `wrangler.toml`. `QUIET_HOURS` is how
long a flight must have gone unheard for its next hearing to count: 6 by
default; 0 for every hearing, which is every ten minutes in sunlight.
`NTFY_PRIORITY` is how loud. Change them there and deploy again, or in the
Cloudflare dashboard under the Worker's settings. Pushover works too: set
`PUSHOVER_TOKEN` and `PUSHOVER_USER` as secrets, instead of or as well as
the ntfy topic.

If the status page reports "ntfy responded 429", ntfy.sh is rate-limiting
Cloudflare's shared outgoing address. The Worker waits and retries, and
tries again on the next tick, so a message is delayed rather than lost;
to make the limit your own, sign up at ntfy.sh (free), create an access
token under Account, and `npx wrangler secret put NTFY_TOKEN`.

The Worker reads the flight list from your site's `/flights.json`, so a new
`[[flights]]` entry is watched as soon as Vercel has rebuilt; there is
nothing to redeploy. The Worker's own address, printed by `deploy`, is a
status page: when it last ran, what it last heard, what it last sent, and
any error. If `deploy` says the KV namespace needs an id, run
`npx wrangler kv namespace create STATE` and paste the id it prints into
`wrangler.toml`.

If you get stuck, open an issue here with your callsign and channel.

## How it works

- `flights.toml` names the flights. The site reads it at build time, the
  ingest tool reads the same file, and both reject the same mistakes.
- `src/data/tracks/<callsign>-<flight_id>.json` is each flight's decoded track,
  committed to git by the workflow so the page has its numbers before any
  network round trip. Beside it, `<callsign>-<flight_id>.ghosts.json` lists
  the slots where the tracker was heard but only its grid square got
  through: the map draws those as hollow "ghost" dots off the track.
- The page then asks wspr.live for everything since the last committed fix,
  decodes it in the browser with a TypeScript port of the tool's decoder,
  and merges. It checks again every two minutes.

[docs/site.md](docs/site.md) is the long version, [docs/architecture.md](docs/architecture.md)
the design, and [docs/telemetry-format.md](docs/telemetry-format.md) the wire
format the decoder implements.

## Repository

- `flights.toml` — the configuration. The one file an instance edits.
- `src/`, `public/` — the site. Astro, static output.
- `flights/` — archived flights, one directory each, rendered statically
  forever. Empty is fine.
- `tool/` — `picolog`, the Python package that ingests and decodes the
  telemetry into SQLite and exports each track. Not the liveness path; the
  browser is.
- `.github/workflows/ingest.yml` — the daily refresh, and the seeding run
  when `flights.toml` changes.
- `notify/` — the optional Cloudflare Worker that taps your phone when a
  flight is heard ("Alerts on your phone" above).
- `dev/` — checks and generators; `docs/` — the design notes.

## Development

```sh
npm install
npm run dev        # http://localhost:4321
npm run build      # static output in dist/
npm run check      # types
npm run verify     # the TypeScript decoder against the Python decoder's vector
```

The tool, from the repository root:

```sh
python3 -m venv tool/.venv && tool/.venv/bin/pip install -e 'tool[dev]'
tool/.venv/bin/pytest tool
tool/.venv/bin/python -m picolog.run --db tool/picolog.db --window-hours 1
tool/.venv/bin/python -m picolog.export_site --db tool/picolog.db
```

## Credits and licence

MIT; see [LICENSE](LICENSE). The data is wspr.live's, a free community
service; every query the site or the tool makes is bounded and narrow. The
telemetry format is Traquito's and QRP Labs' U4B, implemented here from the
published documentation and not from the AGPL reference libraries, so this
repository can be MIT (see [docs/telemetry-format.md](docs/telemetry-format.md)).
Map tiles and weather layers are credited on the map.
