# kr4ogh-pico

A tracking site for pico balloon flights, one site per callsign. This one is
KR4OGH's: **https://kr4ogh-pico.vercel.app**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fryanmio%2Fkr4ogh-pico&project-name=my-pico-balloon&repository-name=my-pico-balloon)

The balloon's tracker sends U4B-style WSPR telemetry. Volunteer stations
hear it and upload every decode to [wspr.live](https://wspr.live/); the
site queries that database from the visitor's browser and decodes the
telemetry in place. There is no server, no database and no API key in the
serving path. The page is current because the visitor's browser asks the
source, whether or not anything of yours is switched on.

It is built to be handed to people who are not radio people: one URL, the
balloon on a map, and the numbers that matter. Follow my balloon here.

## Fly your own

Ten minutes, no terminal. You need a GitHub account and a Vercel account
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

A mistake in `flights.toml` fails the build with a message that names the
field. Fix it and commit again.

### The other way: fork

A fork keeps a link back to this repository, so when it improves, the
**Sync fork** button on GitHub brings your copy up to date; a copy made by
the deploy button has no such button. The price is two more clicks:

1. **Fork** this repository.
2. Open the **Actions** tab of your fork and press the green button to
   enable workflows. GitHub switches them off in forks until asked.
3. Edit `flights.toml` as above and commit.
4. Go to [vercel.com/new](https://vercel.com/new), import your fork and
   press **Deploy**. Nothing to configure.

### Afterwards

- **A new flight** is a new `[[flights]]` entry. Set `active = false` on the
  old one, or `status = "closed"` once it is over for good. The home page
  shows the newest live flight; every flight also has its own address at
  `/live/<flight_id>/`.
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

If you get stuck, open an issue here with your callsign and channel.

## How it works

- `flights.toml` names the flights. The site reads it at build time, the
  ingest tool reads the same file, and both reject the same mistakes.
- `src/data/tracks/<callsign>-<flight_id>.json` is each flight's decoded track,
  committed to git by the workflow so the page has its numbers before any
  network round trip.
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
