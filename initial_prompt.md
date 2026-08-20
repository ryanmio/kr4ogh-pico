Repo: kr4ogh-pico (already created, currently private). Monorepo: /tool, /site, /docs.

You are building the data layer for a personal pico balloon telemetry program. This task
covers ingest, storage, decode, and the Supabase sink. It does NOT cover the CLI UX, the
program-condition flags, the diagnosis report, or the website. Stop at the gate in Step 11.

────────────────────────────────────────────────────────────────────────
HARD GUARDS
────────────────────────────────────────────────────────────────────────

1. This program flies bone-stock Traquito tracker firmware. You will not write, modify, or
   suggest modifying tracker firmware. Nothing here runs on a balloon.

2. Nothing you build is a mission dependency. The authoritative flight record is a local
   SQLite file. The entire tool must run correctly, end to end, with no network beyond the
   wspr.live query and no credentials of any kind. Supabase is a write-only cache for a
   public website; it can be absent, broken, or paused with zero effect on the record.

3. LICENSING. Do not read, clone, vendor, or copy from traquito/WsprEncoded or
   traquito/WsprEncodedPython. Both are AGPL-3.0 and this repo will be published.
   Implement everything from the published format documentation only. Record this
   constraint in /docs/telemetry-format.md.

4. Never pre-announce a launch. No launch times, dates, or site coordinates in any file
   that will be published. Historical data after the fact is fine.

────────────────────────────────────────────────────────────────────────
MISSION CONTEXT
────────────────────────────────────────────────────────────────────────

Callsign KR4OGH, 20 m WSPR, U4B-style channelised telemetry. Two trackers launch the same
morning as one experiment:

  F1A — channel 206, Regular at minute 0, Telemetry at minute 2, 14,097,060 Hz
  F1B — channel 348, Regular at minute 4, Telemetry at minute 6, 14,097,060 Hz

Same callsign, same dial frequency, different minutes, different id13. Attribution needs
all four of: callsign, id13, timeslot, frequency slice. They are separate flights sharing
one launch.

Scoring definitions the data layer must be able to support later:
  Fail    — no signal at any point in the first 12 h after launch; or transmits on day 1
            and never again after the first sunrise
  Pass    — float ≥8,000 m, valid positions spanning ≥48 h, transmits after first sunrise
  Wounded — reporting gap >24 h, presumed alive, flight continues
  Closed  — silence >7 days
Nightly silence from a solar-only payload is expected and is NOT a failure.

────────────────────────────────────────────────────────────────────────
STEP 1 — READ THE SPEC, THEN WRITE IT DOWN
────────────────────────────────────────────────────────────────────────

Fetch and read these before writing any code. Do not infer wire formats from memory or
from other projects' implementations:

  https://traquito.github.io/pro/telemetry/              (Type 1 message format)
  https://traquito.github.io/pro/telemetry/encoding/uniform/
  https://traquito.github.io/pro/telemetry/basic/
  https://traquito.github.io/pro/telemetry/channels/
  https://traquito.github.io/channelmap/help/
  https://traquito.github.io/pro/query/                  (wspr.live query example)
  https://wspr.live/#database-fields
  https://qrp-labs.com/u4b/u4bdecoding.html              (protocol author's own account)

Write /docs/telemetry-format.md in your own words: the two-message scheme, exact field
ranges and step sizes, the mixed-radix packing order for both encode groups, the four
dimensions of the channel system, and the fingerprinting problem. Every factual claim
carries a source URL.

If the packing ORDER is ambiguous after reading, say so in that file and stop. Do not
guess and do not write a decoder you cannot justify line by line.

Commit.

────────────────────────────────────────────────────────────────────────
STEP 2 — CHANNEL TABLE (derive, verify, freeze)
────────────────────────────────────────────────────────────────────────

Derive channel -> (id13, start_minute, frequency_hz) for 20 m.

Here is a candidate mapping fitted to three known points. TREAT IT AS A HYPOTHESIS TO
FALSIFY, not as truth:

    id13_index   = channel // 20
    remainder    = channel %  20
    freq_index   = remainder // 5
    min_index    = remainder %  5
    id13 order   : 00,01,...,09, 10,11,...,19, Q0,Q1,...,Q9
    freq_index   : 0=14097020, 1=14097060, 2=14097140, 3=14097180
    start_minute = (2 * min_index + 8) % 10

It must reproduce all three of these, which are independently known:

    20m ch 123 -> id13 "06", min 4, 14097020   (Traquito ChannelMap API doc example)
    20m ch 206 -> min 0, 14097060              (operator's registered flight F1A)
    20m ch 348 -> min 4, 14097060              (operator's registered flight F1B)

Then validate more broadly: pull at least 20 further channel/id13/minute/frequency
combinations from the live Channel Map or from real flights in the Traquito Flight Log,
and check every one. Report agreements and disagreements.

If it holds, emit tool/picolog/channels_20m.csv (600 rows: channel, id13, min, freq) and
commit it. If it does not hold, build the CSV from scraped Channel Map data instead and
say so plainly. Either way channels.py reads the CSV at runtime — no formula in the hot
path, because a wrong formula silently attributes spots to the wrong flight.

Test asserting the three known points.

Commit.

────────────────────────────────────────────────────────────────────────
STEP 3 — DECODER  tool/picolog/decode.py
────────────────────────────────────────────────────────────────────────

Pure Python, no dependencies. Two independent unpack groups:

    callsign chars 2,4,5,6   ->  grid5, grid6, altitude
    grid (4 char) + power    ->  temperature, voltage, speed, gps_valid, hdr_type

Callsign characters 1 and 3 are the id13 and carry no telemetry. Never feed them to the
unpack.

Implement TRAQUITO behaviour, which differs from the generic spec:
  - values are CLAMPED, not rolled over
  - the voltage window is shifted to 3.0–4.95 V, not the spec's 2.0–3.95 V
  - IsGpsValid is always true from a Jetpack

The temperature field's docstring must state that this is the RP2040 die sensor, not
external air temperature. The program requires external temperature to separate thermal
failure from the other loss modes, and this hardware cannot supply it. Record it in
/docs/telemetry-format.md as a known gap in Flight 1 diagnosability. Do not work around it.

Sanity assertion in tests: the callsign group has 24 * 24 * 1068 = 615,168 possible values
and the grid+power group 90 * 40 * 42 * 2 * 2 = 604,800. Both must fit the available
character space. If your unpack disagrees with those counts, your radix is wrong.

Commit.

────────────────────────────────────────────────────────────────────────
STEP 4 — INGEST  tool/picolog/wsprlive.py
────────────────────────────────────────────────────────────────────────

Query db1.wspr.live over HTTP (ClickHouse, table wspr.rx). Confirm the exact endpoint and
response format from the wspr.live docs — do not assume.

Return raw rows only. No decoding, no filtering beyond the SQL. Two query shapes: Regular
spots by tx_sign; telemetry candidates by id13 pattern + band + minute.

Bounded time windows on every query. wspr.live is a free community service run by one
person; a careless query pattern is a real cost to someone else.

Commit.

────────────────────────────────────────────────────────────────────────
STEP 5 — STORAGE  tool/picolog/store.py
────────────────────────────────────────────────────────────────────────

SQLite via the stdlib. Three tables:

  pulls      utc_run, window_start, window_end, band, query_kind, query_text, row_count
  spots      raw wspr.live rows, every column, unique on the wspr.live row id
  telemetry  decoded rows, each carrying matcher_name and matcher_version

`spots` is append-only. Never updated, never deleted. `telemetry` is fully derivable from
`spots` and is safe to drop and rebuild — that is the point of storing raw.

`pulls` is load-bearing, not bookkeeping. It exists so the tool can distinguish "no query
ever covered this window" from "the balloon was silent." Those are different facts and the
Fail and Wounded definitions depend on telling them apart. Any function that reports a gap
must consult `pulls` and report uncovered windows separately from silent ones.

Commit.

────────────────────────────────────────────────────────────────────────
STEP 6 — MATCHER  tool/picolog/match.py
────────────────────────────────────────────────────────────────────────

One function, `fingerprint_match`, plus NAME and VERSION constants. No abstract base class,
no registry, no plugin system — a second matcher is planned, and swapping a function call
is sufficient.

Pair a Regular spot with a Telemetry spot when the same receiving station reported both, in
consecutive 2-minute slots, with reported frequencies within tolerance OF EACH OTHER — not
within tolerance of the channel's nominal frequency. Receiver calibration error is routine,
and nominal-frequency matching silently discards good data and pollutes other operators'
flights.

Module docstring records the known limitation: this method needs one station to hear both
packets, and loses roughly 6% of otherwise-recoverable records (measured by G0UPL over
VE3KCL's U4B-40 flight: 720 lost of 12,469). The loss concentrates where receiver density
is low — over oceans. Receiver-error-correction matching is the intended alternative and is
why raw spots are retained.

Commit.

────────────────────────────────────────────────────────────────────────
STEP 7 — VERIFICATION GATE
────────────────────────────────────────────────────────────────────────

KR4OGH has not flown yet, so validate against someone else's live flight:

  1. Pick an active 20 m flight from the Traquito Channel Map or Flight Log.
  2. Ingest a full day of its spots through your own stack and decode them.
  3. Open the same flight and dates in the Traquito Flight Search Dashboard, export CSV.
  4. Compare row by row. Report the match rate and every discrepancy with a cause.
  5. Freeze raw spots plus expected decoded output into
     tool/tests/vectors/basic_telemetry.json and write tests against it.

Spot-check individual messages against https://traquito.github.io/pro/decode/

Commit.

────────────────────────────────────────────────────────────────────────
STEP 8 — SUPABASE SINK  tool/picolog/sink_supabase.py
────────────────────────────────────────────────────────────────────────

Supabase is a hot cache for the public site. It is not the flight record and not a backup
— the free tier has zero backup retention. Write-only, one direction: nothing in the tool
ever reads from it.

Schema, as one migration in /supabase/migrations:

  flights    flight_id (F1A/F1B), callsign, channel, band, launch_utc, launch_lat,
             launch_lon, status (live/closed), close_reason
  telemetry  flight_id, utc, grid6, lat, lon, altitude_m, speed_kt, voltage_v,
             temperature_c, gps_valid, rx_station_count, matcher_name, matcher_version
             unique on (flight_id, utc)

No raw spots table. Free tier is 500 MB and raw spots over a long flight would crowd it.
Raw lives in SQLite and in git.

Push is idempotent: upsert on (flight_id, utc), safe to re-run over any window, never
deletes. Re-running after a matcher change overwrites rows with the newer version.

RLS: anon gets SELECT only. Writes use the service role key from the environment. Add
.env.example with placeholder names. .gitignore must cover .env and *.db.

Commit.

────────────────────────────────────────────────────────────────────────
STEP 9 — SCHEDULED RUNNER  .github/workflows/ingest.yml
────────────────────────────────────────────────────────────────────────

Runs the same tool on a cron so the site stays current while the operator's laptop is
asleep. Same Python code — do not write a second implementation in any language. Reads the
active-flight list, pulls the last hour from wspr.live, decodes, upserts.

Check current GitHub Actions free-tier minute allowances for private repos before choosing
an interval. At 10-minute intervals this likely exceeds the private-repo allowance; if so
default to 30 minutes with a comment saying to tighten it when the repo goes public.
Scheduled workflows run late under load — acceptable, since the site displays "last heard"
and the operator's local run is authoritative.

Commit.

────────────────────────────────────────────────────────────────────────
STEP 10 — ARCHITECTURE NOTE  /docs/architecture.md
────────────────────────────────────────────────────────────────────────

Write it, don't build it. Specify a flight-archive export: on flight close, write the full
decoded track plus an outcome summary to /site/flights/<flight_id>/ as JSON + MDX, for
commit to git. Once exported, that flight renders statically forever and never touches the
database. This is what makes it safe for the Supabase project to pause between flights, and
it makes git the durable archive.

Also record the three-store split and why: SQLite is the record, Supabase is a cache, git
is the archive.

Commit.

────────────────────────────────────────────────────────────────────────
STEP 11 — REPORT, THEN STOP
────────────────────────────────────────────────────────────────────────

Write /docs/decode-status.md: which flight you validated against and over what dates, how
many rows matched, every row that didn't and why, whether the channel formula survived
broad validation, and anything in the format you could not resolve from the docs.

Then stop. Do not start the CLI, the condition flags, the diagnosis report, or the site.

────────────────────────────────────────────────────────────────────────
COMMIT DISCIPLINE
────────────────────────────────────────────────────────────────────────

Commit at the end of every numbered step, and at any natural sub-point within a step where
the work stands on its own. Use your judgement on the sub-points; err toward more commits.

  - Never batch two steps into one commit.
  - Never commit with failing tests.
  - Message is a plain imperative sentence: "add basic telemetry decoder". Body only when
    the reason isn't obvious from the diff.
  - No emoji. No "Generated with" footers. No co-author trailers. No conventional-commit
    prefixes. Write commits the way a person does.

────────────────────────────────────────────────────────────────────────
CODE STANDARD
────────────────────────────────────────────────────────────────────────

Python 3.11+. Stdlib plus `requests` only. pytest for tests. pyproject.toml, no other
packaging machinery. No frameworks, no compiled extensions.

Write it the way a good developer writes a small tool they'll maintain for years:

  - Solve the problem in front of you. No abstraction with one implementation, no config
    system, no dependency injection, no plugin architecture, no ORM. A dataclass read from
    a TOML file is the config layer.
  - Comments explain why, never what. If a comment restates the line below it, delete it.
    Every magic number carries a source URL.
  - Let errors raise. No bare except, no except that logs and continues. The one exception
    is the Supabase push, which must fail loudly but non-fatally.
  - Type hints on public function signatures. Not on every local variable.
  - Short functions with real names. No `process_data`, no `handle`, no `utils.py`.
  - Tests cover the codec, the channel table, and the matcher against real recorded data.
    Do not write tests that assert mocks were called.
  - No network in tests. Fixtures are local.
  - README is short: what it is, how to run it, where the data goes.

Callsign, channel, band, and dates are configuration. Never hardcoded, including in tests.

Where a Traquito page contradicts anything in this prompt, follow the page and say so
explicitly in your report.