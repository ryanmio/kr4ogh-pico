# Cross-receiver pairing: telemetry heard without a same-station Regular

Status: **built 2026-11-03, on the `cross-receiver-pairing` branch, not
merged.** The Step 1 findings were written first, before any code changed,
and are kept as they were. The design, the results and the spot-check list
follow them.

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

## What was built

The same-station rule is kept exactly as it was, now called the
**confirmed** tier. A second, **inferred** tier is tried only on the
cycles the confirmed tier left empty. It is in `tool/picolog/infer.py`,
with a line-for-line copy in `src/lib/wspr/infer.ts` for the browser.
`npm run verify` checks that the two agree on every row, every reason and
every decision.

### The checks, in plain terms

A `1?0???` message with no same-station pair is accepted as PT01's only
if **all** of these hold.

1. **Right minute, right frequency.** Basic telemetry at :x2, sensor at
   :x6. At least one station reported it between **14,097,050 and
   14,097,095 Hz**. That is the 14,097,055–14,097,090 spread from the
   brief, plus 5 Hz of margin each side. It stops short of the halfway
   points to the neighbouring channels (14,097,040 and 14,097,100).
   *This lane is new.* The code had none, so it is a choice for you to
   confirm or change: `LANE_BELOW_HZ` and `LANE_ABOVE_HZ` in `infer.py`
   and `infer.ts`.
2. **It decodes as ours.** Basic telemetry needs the GPS-valid bit set.
   The sensor message needs header TelemetryType 0, RESERVED 0, Type 0 and
   Slot 3, and the sensor must have answered (not −70 / 0 / 0).
3. **There is a grid square for it.** KR4OGH's Regular message from the
   same cycle, heard by any station, comes first. Failing that, the
   nearest Regular heard *before* and the nearest heard *after*. Each must
   be within 30 minutes of the cycle, and both must report the same
   square. "Neighbouring cycles" has to stretch past the very next cycle,
   because the 04:02 fixture's neighbours are 03:50 and 04:20 (04:10 was
   not heard).
4. **It fits the flight.**
   - **Distance:** it is reachable from the last believable fix at
     1.5 × the larger of its reported speed and 100 kt. Slack is added
     for where a position can sit inside its square (15 km for a 6-character
     square, 140 km for a 4-character one).
   - **Altitude:** it is within 1,500 m of the last believable
     **confirmed** fix. An inferred fix can be measured *from*, but it
     never resets what "float" means.
   - **No teleport and snap back:** it must also be reachable from and to
     the Regular squares heard either side of it.
   - A sensor reading has no position of its own. Its square must be
     reachable, and its pressure altitude must be within 1,500 m of the
     cycle's fix (or of float, when the cycle has no fix).
5. **It is the only one.** If two different messages in the same slot
   both pass, neither is taken and the cycle is marked **ambiguous**.

"Believable" means the site's GPS-spoof rule (`src/lib/spoof.ts`),
copied in. A fix whose pressure and GPS altitudes disagree by more than
3 km, or that couldn't be reached at 300 kt, is never used as the fix the
next one is measured from. It stays confirmed, exactly as before. It just
isn't trusted as a reference point.

### What is stored

- `telemetry` gains `tier` ("confirmed" or "inferred"), `pairing` (the
  reason), `sensor_tier` and `sensor_pairing`. A reason reads like:
  `cross-receiver; grid neighbours 03:50+04:20 NM21; heard by UA9720SWL at
  14097071 Hz; sole candidate`.
- `ghosts` gains the sensor fields, so a reading from a cycle with no fix
  can ride on that cycle's ghost. A cycle with no Regular at all whose
  sensor reading was placed from its neighbours gets a ghost of its own,
  marked `grid_source = "neighbours"`.
- A new `pairings` table records every cycle the inferred tier looked at:
  accepted, rejected, unplaced or ambiguous, with the reason.
- Raw spots are untouched, and all of it is rebuilt from them on every run.
- The committed track JSON writes `tier` and `pairing` **only on inferred
  points**. Every confirmed point is byte-for-byte what it was.
- The export normally merges and never drops a point. It now withdraws a
  committed inferred point when the database has since looked at that
  cycle again and not accepted it, so tightening a rule can take points
  back off the site.

### How the site uses inferred points (your defaults, as specified)

| Where | Inferred points |
|---|---|
| Flight path | On the line. Drawn as a **ring** in the metric's colour round a dark centre, where a confirmed fix is a solid dot. There is no map key for it: the ring's tooltip says "telemetry fix, cross-receiver pairing", and the Signal panel and data table explain it. The globe view draws no per-fix dots, so there is nothing to restyle there. |
| Latest-state cards | Altitude, speed, voltage, temperature and receivers read the newest fix of either tier. When it is inferred, each card's label says "· inferred", with an explanation on hover. The Signal panel gains a "Last fix" line with the tier, and a count of cross-receiver fixes. |
| Forecast start | The newest fix of either tier (unchanged code: `forecastOrigin` takes the last fix). |
| Records and the peak / fastest lines | Confirmed only. That covers highest, fastest, most heard and coldest. Distance flown, farthest from launch and time aloft take every fix. |
| Distance | Includes inferred points. |
| Sensor readings | Attached to the cycle's fix, or else to its ghost, using the same square rules. A tier column appears in the data table once any inferred row exists, and a ghost's tooltip shows its reading and tier. **There is no sensor card on the site today**, so there was no tile to change. |

One small change you didn't ask for. A *confirmed* sensor reading in a
cycle with no fix used to be dropped. It now rides on that cycle's ghost.
This happens once in the whole flight (1 Nov).

### Live page vs committed track

The browser now runs both tiers too, and it passes the bundled track in
as the "previous fix". So the live page shows the Tibet fixes as soon as
it loads. With this branch, the dashboard's newest fix is **3 Nov 08:50Z,
NM62hi, 10,760 m, inferred**, not 2 Nov 10:50Z. The forecast starts there.

The daily scheduled run uses a throwaway database holding only the last
26 hours. It now reads the committed track as context, because without it
the first candidate of the day has nothing to be measured from. I tested
exactly that case: without context it accepts nothing, with context it
accepts the same 4 Tibet fixes. Inferred points from earlier days (31 Oct,
1 Nov, 2 Nov) only reach the committed track through a full replay: run
the ingest workflow by hand with "from launch" ticked after merging.

## Results: the whole of PT01, before and after

From the scratch copy of the record, rebuilt from raw spots. "Fix" is a
cycle with a position. "Ghost" is a cycle heard as a Regular only.

**Basic telemetry and ghosts**

| UTC day | Before: fixes | Before: ghosts | After: confirmed | After: inferred | Ambiguous | Not placed / rejected | After: ghosts |
|---|---|---|---|---|---|---|---|
| 10-24 | 31 | 0 | 31 | 0 | 0 | 0 / 1 | 0 |
| 10-25 | 37 | 2 | 37 | 0 | 0 | 1 / 1 | 2 |
| 10-26 | 37 | 1 | 37 | 0 | 0 | 0 / 0 | 1 |
| 10-27 | 43 | 2 | 43 | 0 | 0 | 0 / 0 | 2 |
| 10-28 | 43 | 4 | 43 | 0 | 0 | 0 / 0 | 4 |
| 10-29 | 42 | 4 | 42 | 0 | 0 | 0 / 0 | 4 |
| 10-30 | 40 | 1 | 40 | 0 | 0 | 0 / 1 | 1 |
| 10-31 | 33 | 3 | 33 | **3** | 0 | 0 / 0 | 0 |
| 11-01 | 39 | 3 | 39 | **2** | 0 | 0 / 1 | 2 |
| 11-02 | 43 | 3 | 43 | **1** | 0 | 0 / 2 | 2 |
| 11-03 | **0** | 12 | 0 | **4** | 0 | 0 / 0 | 10 |
| **Total** | 388 | 35 | 388 | **10** | 0 | 1 / 6 | 28 |

**Sensor readings**

| UTC day | Before: on a fix | After: confirmed | After: inferred | Ambiguous | Not placed | Rejected |
|---|---|---|---|---|---|---|
| 10-24 | 30 | 30 | 0 | 0 | 1 | 0 |
| 10-25 | 34 | 34 | 1 | 0 | 0 | 2 |
| 10-26 | 36 | 36 | 0 | 0 | 0 | 3 |
| 10-27 | 40 | 40 | 2 | 0 | 0 | 10 |
| 10-28 | 39 | 39 | 0 | 0 | 0 | 22 |
| 10-29 | 40 | 40 | 0 | 0 | 0 | 22 |
| 10-30 | 38 | 38 | 1 | 0 | 0 | 0 |
| 10-31 | 27 | 27 | **8** | 0 | 3 | 4 |
| 11-01 | 35 | 36 | **5** | 0 | 0 | 26 |
| 11-02 | 39 | 39 | 1 | 0 | 0 | 0 |
| 11-03 | 0 | 0 | **4** | 0 | 2 | 0 |
| **Total** | 358 | 359 | **22** | 0 | 6 | 89 |

- **No confirmed fix changed**, on any day. A test checks this.
- **No cycle in the whole flight was ambiguous.** Where the strict rule
  failed, exactly one candidate passed or none did.
- The 89 rejected sensor messages are almost all other balloons' messages
  in the :x6 slot, mostly basic telemetry from other `1?0` trackers. They
  fail check 2.
- The 6 rejected basic-telemetry cycles: three are other formats in the
  slot (HdrType 15 on 24 Oct 15:02 and 25 Oct 10:02, HdrType 14 on 2 Nov
  03:12), one had GPS-valid = 0
  (30 Oct 19:40, PT01 was dark), and two had no report inside the lane.

### The fixtures

All four basic-telemetry fixtures come out as specified: 04:02 NM21oq
31.69N 85.21E 10,660 m 72 kt; 07:32 NM52fg 32.27N 90.46E 10,780 m 82 kt;
08:02 NM52ph 32.31N 91.29E 10,720 m 82 kt; 08:52 NM62hi 32.35N 92.62E
10,760 m 82 kt. Four of the six sensor fixtures are placed: 03:56, 07:46
(from its neighbours), 07:56 and 08:36. **03:16 and 09:26 are reported as
unplaceable, not forced.** 03:16's neighbours disagree (NM11, then NM21),
and nothing was heard after 08:50 to bracket 09:26.
`tool/tests/test_infer.py` asserts all ten, against values worked out by
hand.

### Negative tests

- **:x4.** All 268 `1?0` spots at :x4 over the whole flight were offered
  to the inferred tier as both kinds of message. None was accepted; the
  slot check refuses every one. Nothing at :x4 is ever pulled into the
  pipeline in the first place.
- **Other headers.** The flight's in-lane extended messages that aren't
  PT01's format are 9 with HdrType 15 (2 at :x2, 5 at :x4, 2 at :x6) and
  one HdrType 14 at :x2 (2 Nov 03:12). All are refused. The overnight 31 Oct traffic is basic telemetry from other
  balloons sent in PT01's sensor minute: 1G0JWP 19:06, 150LMS 20:26,
  1U0ZBA 21:26, 1P0XXO 22:16, plus an HdrType 15 at 18:44 (:x4). All
  are refused as "not the sensor message".
- **31 Oct 13:20–14:10.** As noted above, these are PT01's own sensor
  messages, not HdrType 15. 13:26 is placed, in JM60 from the 13:10 and
  13:30 Regulars. 13:46, 13:56 and 14:16 are not placed, because no
  Regular was heard within half an hour after them.
- **The 1 Nov spoof (12:00 and 12:30, LM43bm, 200 m, 0 kt).** These stay
  **confirmed**, unchanged, and the site's spoof filter still sets them
  aside as before. Had they arrived unpaired, the new checks would have
  refused both. The first is 463 km from the 11:50 fix after 10 minutes,
  when 1.5 × 100 kt plus the square slack allows 76 km. They are also 10.7 km
  below float. They are also never used as the fix the next one is
  measured from: the 2 Nov 03:40 inferred fix was measured from 1 Nov
  11:50.

## For you to spot-check: inferred points that aren't fixtures

Each is shown with the confirmed fixes either side of it, where there are
any.

**Basic telemetry (6)**

| UTC | Position | Alt / speed | Square from | Heard by | Confirmed before → after |
|---|---|---|---|---|---|
| 10-31 10:00 | JM30en | 10,840 m, 82 kt | same cycle | EA4RCW | 09:50 JM30an 10,880 → 10:10 JM30hn 10,900 |
| 10-31 10:40 | JM30so | 10,840 m, 82 kt | same cycle (HB9VQQ) | 12 stations | 10:30 JM30oo 10,840 → 10:50 JM30vo 10,880 |
| 10-31 12:10 | JM50dp | 10,840 m, 82 kt | same cycle | 11 stations | 12:00 JM40xp 10,840 → 12:20 JM50hp 10,840 |
| 11-01 09:50 | LM30nd | 10,940 m, 66 kt | same cycle | DK6UG | 09:40 LM30le 10,960 → 10:10 LM30sa 10,820 |
| 11-01 10:00 | LM30pb | 10,940 m, 64 kt | neighbours 09:50+10:10 | 4X1DA, ES4O | 09:40 LM30le 10,960 → 10:10 LM30sa 10,820 |
| 11-02 03:40 | ML05pq | 10,860 m, 44 kt | same cycle | OK2IP/P, ZL2P | (overnight) → 03:50 ML05rr 10,860 |

**Sensor readings (18)**, each with the nearest earlier confirmed pressure:
10-25 18:20 on fix FN82mj, 250 hPa (prev 250); 10-27 10:10 HM61wd 248
(247); 10-27 13:10 HM71mw 248 (248); 10-30 15:20 ghost IM44 from
neighbours 248 (248); 10-31 08:20 JM10tl 246 (247); 10-31 10:00 JM30en
249 (248); 10-31 10:30 JM30oo 246 (247); 10-31 10:40 JM30so 247 (247);
10-31 10:50 JM30vo 246 (247); 10-31 11:00 JM40bo 248 (247); 10-31 12:10
JM50dp 245 (246); 10-31 13:20 ghost JM60 from neighbours 247 (246); 11-01
06:40 LM10lv 245 (245); 11-01 09:00 LM30bj 245 (245); 11-01 09:20 ghost
LM30 244 (245); 11-01 10:00 LM30pb 250 (250); 11-01 11:40 LL49nm 250
(248); 11-02 05:30 ML16ja 250 (250).

## Choices left to you

- **The lane, 14,097,050–14,097,095 Hz.** New, because the code had none.
- **Records leave out inferred fixes.** That covers highest, fastest, most
  heard and coldest, which is broader than "peak altitude, fastest speed".
  Say if most-heard and coldest should count them.
- **Cards say "inferred".** "Cross-receiver" didn't fit the card labels.
  The map key, table and Signal panel use the full wording.
- **Backfill.** After merging, run the ingest workflow once with "from
  launch", so the 31 Oct – 2 Nov inferred points join the committed track.
