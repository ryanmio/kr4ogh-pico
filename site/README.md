# site

The public website for KR4OGH pico balloon flights. Astro, static output.

Two data paths, per `docs/architecture.md`:

- **Archived flights** are read at build time from `site/flights/<flight_id>/`
  (`flight.mdx` narrative + `track.json` full decoded track), committed to
  git by the flight-archive export. These pages are fully static and never
  touch a database.
- **Live flights** are read in the browser from the Supabase cache with the
  anon key (RLS allows SELECT only). If the cache is unset, paused, or
  broken, the live section degrades to a notice and everything else still
  works.

## Run

```sh
npm install
npm run dev        # http://localhost:4321, archived flights only
npm run build      # static output in dist/
```

To see the live path without a Supabase project, replay local data through
the mock cache (uses `tool/demo.db`; rebuild it from the frozen test vectors
if absent — see `tool/tests/test_vectors.py` for the replay recipe):

```sh
python3 dev/mock_supabase.py --db ../tool/demo.db \
    --flights dev/demo_flights.toml --shift-to-now
PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 PUBLIC_SUPABASE_ANON_KEY=dev npm run dev
```

Against the real cache, copy `.env.example` to `.env` and fill in the
project URL and anon (or publishable) key. Both values are compiled into the
client bundle; that is safe for the anon key and why the service role key
must never appear here.

## Deploy

`.github/workflows/site.yml` builds and deploys to GitHub Pages on push to
`main` once Pages is enabled (source: GitHub Actions). `SITE_URL` /
`SITE_BASE` are derived from the Pages configuration; the Supabase values
come from repository Actions variables and may be left unset.
