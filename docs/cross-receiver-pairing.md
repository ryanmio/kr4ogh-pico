# Cross-receiver pairing: telemetry heard without a same-station Regular

Status: **Step 1 findings, written 2026-11-03 before any code changed.**
The design and results are added below them as the work lands.

## Words used here

- **Regular message**: the :x0 transmission. It carries the callsign
  KR4OGH, a 4-character grid square (about 110 km by 190 km at PT01's
  latitude) and the power.
- **Basic telemetry**: the :x2 transmission. Its callsign looks like
  `1?0???`. It carries the 5th and 6th grid characters (which narrow the
  square down to about 4 km), the altitude, the speed and the GPS-valid bit.
- **Sensor message**: the :x6 transmission from the Petrel board, which is
  also `1?0???`. It carries temperature, pressure and humidity.
- **Cycle**: one 10-minute round of the three messages, named by its
  Regular minute (for example the 04:00 cycle is 04:00, 04:02 and 04:06).
- **Pairing**: deciding that a `1?0???` message belongs to *our* balloon.
  The callsign alone can't prove that, because many balloons send `1?0`
  callsigns on this frequency.
- **Fingerprint pairing** (today's only rule): the *same receiving
  station* heard both our Regular message and the telemetry message, and
  reported their frequencies within 5 Hz of each other.
- **Ghost**: a cycle where our Regular message was heard but no telemetry
  could be paired with it. The site knows the grid square and nothing else.
- **Fix**: a full position with altitude and speed. It needs a Regular and
  a basic telemetry message.

## What the code does today

### Where a ghost is decided

- `tool/picolog/match.py`, `regular_only_slots` (line 107), called from
  `tool/picolog/pipeline.py`, `rebuild_flight_telemetry` (line 123). The
  browser has a line-for-line copy: `src/lib/wspr/match.ts`,
  `regularOnlySlots` (line 129), called from `src/lib/wspr/track.ts`,
  `decodeWindow` (line 111).
- The rule: a Regular cycle is a ghost when `fingerprint_match` found no
  telemetry message heard *by the same station* within 5 Hz of that
  station's Regular report. It is also a ghost when the pair it found
  didn't decode as basic telemetry. If several stations heard the Regular,
  the grid square is put to a vote, one vote per station, and a tied vote
  drops the cycle.

One thing worth knowing. **A telemetry or sensor message with no pair is
not a ghost. It is discarded entirely.** The ghost is the Regular message
that was left without a partner. So on 3 Nov the map shows E28AC's
Regular messages as ghost rings. UA9720SWL's telemetry and sensor messages
from the same cycles appear nowhere on the site, and nowhere in the
database's decoded tables either. They survive only as raw spots.

### Where ghosts are left out

| Where | File | What it does with ghosts |
|---|---|---|
| Flight path | `src/lib/map.ts`, `src/lib/globe.ts` | Hollow grey rings that never join the line. A dashed tail runs from the last fix to the newest ghost. |
| Stats (distance, peak, fastest) | `src/lib/format.ts` `trackStats` | Reads the track (fixes) only. |
| Latest-state tiles | `src/lib/render.ts` `sidebarHtml` | Altitude, speed, voltage, temperature and receivers all come from the last *fix*. Ghosts only feed "Heard … ago" and "flying for". |
| Forecast start | `src/lib/forecast.ts` `forecastOrigin` | "Always the newest full fix, never a newer ghost." |
| Records | `src/lib/records.ts` `summarize` | Fixes only. |
| Sensor readings | `tool/picolog/pipeline.py` line 81, `track.ts` `decodeWindow` | A sensor reading rides on its cycle's fix. A sensor reading in a cycle with no fix is dropped, even when it was paired by fingerprint. |

That's why the dashboard is stuck on 2 Nov 10:50Z (the 10:52 telemetry,
ML37pg in Pakistan). Every number on it is read from the last fix, and no
fix has been decoded since.

### Receiver-count and frequency filters

- **No receiver-count filter anywhere.** There is no `HAVING`, no
  `count > 1`, no minimum station count. This holds in the wspr.live
  queries (`tool/picolog/wsprlive.py`, `src/lib/wspr/query.ts`), at insert
  (`store.py` keeps every row), in pairing (one station is enough for a
  fingerprint pair) and in the ghost vote (one station is enough). A
  single-receiver spot is kept everywhere. That isn't what lost 3 Nov.
- **No frequency filter at ingest.** The queries select by band, callsign
  pattern and minute only. The only frequency test in the code is the
  *relative* one in fingerprint pairing: telemetry within 5 Hz of the same
  station's Regular report.
- **There is no "lane window" in the code today.** Nothing checks a
  frequency against channel 206's 14,097,060 Hz. The new tier needs one,
  so it is defined below. The neighbouring channels with the same `1?0`
  pattern and start minute sit at 14,097,020 (ch 201), 14,097,140 (ch 211)
  and 14,097,180 (ch 216). Halfway to them is 14,097,040 and 14,097,100.
- **Minute filters**: Regular at minute % 10 = 0, telemetry at 2, sensor
  at 6. Nothing is pulled at :x4. I pulled :x4 separately for the
  negative test below.

### The stack is not quite what the brief describes

There is no Supabase and no Next.js any more. `docs/architecture.md`
records that the Supabase cache was removed. The site is Astro on Vercel.
The visitor's browser queries wspr.live directly and decodes the spots
itself, using a TypeScript copy of the Python decoder. `npm run verify`
checks that copy row for row against the same frozen test data. So a
pairing change has to be made **twice, in Python and in TypeScript**, or
the live page and the committed track would disagree.

### The local record

`tool/picolog.db` ends on 3 Oct, so it holds nothing from PT01. The
counts below come from a scratch copy that I pulled from launch with the
tool's own code (33,046 spots, plus 268 at :x4). Your file was not
touched.

## Step 1 counts: PT01 since launch, by UTC day

A cycle counts once per kind. "Unpaired" means a `1?0` message in the
lane (see below) at :x2 or :x6 whose cycle has no fingerprint pair of
that kind. "PT01-shaped" means it also decodes as our format: basic
telemetry, or a sensor header with Type 0 and Slot 3. Unpaired includes
other balloons' messages, so treat it as an upper bound.

| UTC day | Regular cycles heard | Fixes (paired) | Ghosts | Telemetry unpaired | … PT01-shaped | Sensor paired | Sensor unpaired | … PT01-shaped |
|---|---|---|---|---|---|---|---|---|
| 10-24 | 31 | 31 | 0 | 1 | 0 | 30 | 1 | 1 |
| 10-25 | 39 | 37 | 2 | 2 | 1 | 34 | 3 | 1 |
| 10-26 | 38 | 37 | 1 | 0 | 0 | 36 | 2 | 0 |
| 10-27 | 45 | 43 | 2 | 0 | 0 | 40 | 12 | 2 |
| 10-28 | 47 | 43 | 4 | 0 | 0 | 39 | 22 | 0 |
| 10-29 | 46 | 42 | 4 | 0 | 0 | 40 | 22 | 0 |
| 10-30 | 41 | 40 | 1 | 1 | 1 | 38 | 1 | 1 |
| 10-31 | 36 | 33 | 3 | 3 | 3 | 27 | 15 | 11 |
| 11-01 | 42 | 39 | 3 | 2 | 2 | 36 | 30 | 5 |
| 11-02 | 46 | 43 | 3 | 2 | 1 | 39 | 1 | 1 |
| 11-03 | 12 | **0** | **12** | 4 | 4 | 0 | 6 | 6 |
| **Total** | 423 | 388 | 35 | 15 | 12 | 359 | 115 | 28 |

Over most of the flight the strict rule loses very little: 388 of 423
heard cycles became fixes. 3 Nov is the exception. All 12 heard cycles
became ghosts, and every telemetry and sensor message that day was heard
by a different station from the one that heard the Regular.

## Things the brief assumed that the data doesn't bear out

1. **The 03:16 sensor reading can't be placed by the stated grid rule.**
   Its cycle (03:10) has no Regular. The nearest Regulars either side are
   02:50 (NM11) and 03:30 (NM21), which disagree. The balloon crossed from
   NM11 into NM21 somewhere in that gap. 09:26 can't be placed either,
   because no Regular was heard after 08:50. Both are reported, not forced.
2. **The 31 Oct 13:20–14:10Z extended messages are not HdrType 15.** They
   decode as header Type 0, Slot 3, which is PT01's own sensor format.
   Their readings (245–248 hPa, −9 to −20 °C) match PT01's paired readings
   from that hour (245–247 hPa). They are almost certainly PT01's sensor
   messages, sent while its Regular and basic messages went unheard over
   the eastern Mediterranean. HdrType 15 messages do occur in the lane: 9
   across the flight, at :x2, :x4 and :x6 (listed under "Negative tests"
   below).
