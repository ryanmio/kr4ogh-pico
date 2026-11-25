# Partial spots: showing a Regular message with no Telemetry

Status: **built 2026-09-07**, as "ghosts": see "What was built" at the end.
The rest of this note is the analysis it was built from, written
2026-08-31 after F1B's first sunset, and still the reference for why the
site draws these the way it does.

## The shape of the problem

A U4B fix is two WSPR transmissions two minutes apart:

- **Regular** (slot 0) — callsign, grid4, power. Grid4 is a ~1 deg x 2 deg
  box: roughly 80 km of positional uncertainty.
- **Telemetry** (slot 1) — grid5, grid6, altitude, speed, voltage,
  temperature, GPS-valid.

`tool/picolog/match.py` and its port `src/lib/wspr/match.ts` require
both, from the same receiving station, within 5 Hz. Everything downstream --
the SQLite `telemetry` table, the committed `src/data/tracks/*.json`,
the map, the stats, the charts -- is built from full fixes only. A slot where
only one message was heard produces nothing and leaves no trace on the site.

`docs/decode-status.md` already recorded this during channel-343 validation:
3 of 70 dashboard rows carried a Regular spot with no telemetry, and were
correctly excluded from the decode comparison. What that note did not say is
that those rows are still *positions*, and that a reader of the site cannot
tell the difference between "no message arrived" and "half a message
arrived".

## Where it actually bites

Not uniformly across a flight. It clusters at the ends, which is where the
information is worth most.

F1B, 2026-08-30 (channel 348, KR4OGH, 20 m), swept straight from wspr.live:

| Slot (UTC) | Regular rx | Telemetry rx | On the site |
| --- | --- | --- | --- |
| 12:44 | 1 (FM19) | 0 | no |
| 13:54 - 20:34 | 24-49 | 21-48 | yes, all 41 slots |
| 20:54 | 14 (FM38) | 0 | no |
| 21:14 | 15 (FM38) | 0 | no |
| 21:34 | 42 (FM38) | 0 | no |

The launch slot and the last three slots before the tracker went dark. 42
stations heard the balloon at 21:34 and the site's last position is an hour
earlier. All three late slots report grid FM38, so they are one map dot, not
three.

The telemetry-looking rows present in those slots (20:56, 21:06, ... at
~14,097,024 Hz) belong to other operators sharing id13 "17" and the same
minute on a different frequency lane. The matcher is right to refuse them;
this is exactly the pollution the fingerprint rule exists to prevent.

## How Traquito handles it

Read out of the dashboard source at
`traquito.github.io/search/spots/dashboard/js/`, 2026-08-31.

`WsprSearch.ForEachWindow` emits a row for every 10-minute window in which
**any** slot has exactly one surviving candidate -- so a Regular-only window
is still a row. Position is then resolved by
`WsprSearchResultDataTableBuilder.js` from a ranked list of sources, each
with a declared uncertainty (`GetLocationSourceUncertaintyKm`):

| Source | Derived from | Precision shown | Uncertainty |
| --- | --- | --- | --- |
| `GT+TT` | extended telemetry, indexed lat/lon plus sub-index | 6 dp | 2.25 km |
| `BT` | grid4 (Regular) + grid5/6 (Telemetry) -- what we do | 4 dp | 4 km |
| `RT1` | grid4 alone, Regular only | 2 dp | **80 km** |

The highest-ranked available source wins into the row's `Lat`/`Lng`, and the
map plots that -- so an `RT1` row is a dot, just a very coarse one. Three
details are worth copying rather than reinventing:

1. **Provenance survives.** The row records
   `sourceByFamily.location = "RT1"`, and the columns that lost the ranking
   are italicised rather than dropped.
2. **Missing telemetry stays missing.** Altitude, speed, voltage and
   temperature are blank on an `RT1` row. Nothing is interpolated.
3. **Derived values are uncertainty-aware.** Distance-travelled uses the
   coarse position, but GPS speed explicitly skips any segment touching an
   `RT1` point: *"Ignore coarse RT1-only positions here. GPS speed should be
   driven only by refined GPS-derived location sources."* An 80 km jitter
   across a 10-minute slot would otherwise read as ~480 km/h of noise.

Aside, since it has now cost debugging time twice: the dashboard's visible
time column is `DateTimeLocal`, not UTC. `docs/decode-status.md` records the
same trap for its `dtGte`/`dtLte` inputs. A dashboard row reading 17:34 in a
US-Eastern browser is 21:34 UTC.

## If we build it (the plan as first written)

Mirror the Traquito model. It is the reference the site is checked against,
and disagreeing with it silently is a bug by definition.

- `src/lib/types.ts` -- `TrackPoint` gains `source: "BT" | "RT1"`;
  `altitude_m`, `speed_kt`, `voltage_v`, `temperature_c`, `gps_valid` become
  nullable.
- `src/lib/map.ts` -- `RT1` points render as a hollow grey marker with a
  translucent ~80 km circle, not an altitude-coloured dot: a plain dot claims
  a precision the data does not have. `altLo`/`altHi` must skip nulls.
- `src/lib/render.ts` -- **the fiddly part.** `statsHtml` reads
  `s.last.altitude_m`, `.speed_kt`, `.voltage_v`, `.temperature_c` off the
  final point. "Last" has to become "last point carrying telemetry", or the
  stat strip blanks out exactly when the balloon goes quiet, which is when it
  is being watched hardest. `tableHtml` needs em-dash cells and a source
  column.
- `src/lib/format.ts` -- `trackStats` min/max/last skip nulls; distance
  may use every point.
- `src/lib/charts.ts` -- skip nulls rather than plotting zero.
- `tool/picolog/pipeline.py`, `store.py`, `export_site.py` -- emit and store
  `RT1` records; the `telemetry` table currently holds full records only.
- `dev/verify-port.ts` -- keep the Python and TypeScript decoders
  row-for-row comparable across the new shape.

Roughly eight files, all mechanical apart from the `statsHtml` question.

## Why it is not built yet

An 80 km dot is a real claim about where the balloon is, and it will sit on
the map looking exactly as authoritative as a 4 km one unless the styling
works hard. Getting that wrong is worse than the gap it fills. The gap is
also small in the middle of a flight and only opens at the edges, so the
cost of waiting is bounded and legible.

## What to watch

- How often partial slots land at the **end** of a transmitting day. F1B's
  first sunset lost 3 consecutive slots and about an hour of last-known
  position.
- Whether a flight ever ends on a partial slot, making the true last known
  position invisible on the site.
- Ocean crossings, where receiver density is low: `match.ts` already notes
  roughly 6% of otherwise-recoverable records lost to the same-station
  requirement, concentrated there. Partial-slot loss should track that.

If those add up, build it. If partials stay a handful of edge slots per
flight, the strict both-messages rule is the better default.

## What was built

The Traquito model, with one change of shape: the coarse positions are a
second list beside the track, not nullable rows inside it.

- `src/lib/types.ts` -- `GhostPoint`: `utc`, `grid4`, `lat`, `lon`,
  `rx_station_count`. Nothing else, because nothing else is known.
  `TrackPoint` is untouched.
- `src/lib/wspr/match.ts` / `tool/picolog/match.py` -- `regularOnlySlots`
  / `regular_only_slots`: every Regular slot the matcher produced no
  decodable fix for. The grid square is put to the same distinct-receiver
  vote as a telemetry payload; a tie skips the slot.
- `src/lib/wspr/track.ts` -- `decodeWindow` returns `{ track, ghosts }`;
  `tool/picolog/pipeline.py` writes a `ghosts` table beside `telemetry`,
  replaced whole on each rebuild so a slot that later completes stops
  being a ghost. `export_site.py` writes
  `src/data/tracks/<callsign>-<id>.ghosts.json` next to the track, merged
  the same way and pruned against the merged track. The browser refresh
  (`src/lib/livetrack.ts`) does the same merge and prune.
- `src/lib/ghosts.ts` -- the questions that need both lists: `lastKnown`,
  `heardBounds`, `trailingGhosts`, and unwrapping a ghost's longitude next
  to the track's.
- `src/lib/map.ts`, `src/lib/globe.ts` -- ghosts are small hollow grey
  rings under the spots, uncoloured by the metric. They never join the
  line. When ghosts are newer than the last fix, a dashed tail runs from
  the last fix through them, the beacon moves to the newest, and the grid
  square it stands for is outlined: the beacon alone would claim 4 km.
- `src/lib/render.ts`, `FlightLive.astro` -- "last heard" and how long it
  has been flying count ghosts as the tracker being heard, and the status card says
  "position only" when the newest report is one. Every metric card, chart,
  the table and the speed derivation read the track alone, which is the
  "statsHtml question" above answered by construction: there is no null to
  skip.

Why two lists rather than nullable fields: the plan above touched eight
files "all mechanical apart from the statsHtml question". With a separate
list the stats, charts, table, range slicing and speed window need no
change at all, the archive format is unchanged, and a ghost cannot be
mistaken for a fix anywhere a `TrackPoint` is read.

What the first export found, seeded from wspr.live on 2026-09-07: F1B's
launch slot at 12:44 and its three FM38 sunset slots from the table above,
plus one slot ten minutes after what had been its last fix; F2A and F2B
each ending, that morning, on a ghost.

## Since: the inferred tier (2026-11-03)

Over Tibet on 3 Nov 2026 every one of PT01's cycles was a ghost. One
station heard the Regular messages and another heard the telemetry, so the
same-station rule linked nothing. A second, lower-confidence pairing tier
now fills such cycles when exactly one candidate passes stricter checks
(lane, decode, grid square, path and altitude). Its fixes are on the track
marked `tier: "inferred"` and drawn as rings. Its sensor readings can ride
on a ghost. See docs/cross-receiver-pairing.md.

## Since: held for one cycle (2026-11-13)

A live flight's newest slot is a ghost for a few minutes of every cycle:
the Regular reaches wspr.live before the Telemetry sent two minutes after
it. Drawn at once, the beacon jumped into a grid square and back every ten
minutes, which reads as the balloon veering off course. A ghost is now held
back until its slot is ten minutes old (`GHOST_HOLD_MS`, `settledGhosts` in
`src/lib/ghosts.ts`), so it shows only when its telemetry really was lost.
The hold is applied where ghosts reach the page (the build's render, the
bundled data, the fetched files and `refreshTrack`); the stored and
committed ghosts are unchanged. A held ghost appears on the first refresh
after its hold ends, at most one refresh interval (2 min) late.

## Since: not after a silence (2026-11-17)

PT-02's first slot after a 16-hour night, 21:44 UTC on 17 Nov over the
North Pacific, was a ghost, and the hold kept it off the page until
21:54, while everyone watching was waiting for exactly that report. The
hold exists to stop the beacon hopping away from a fix ten minutes old;
after a long silence there is no such fix. A ghost that follows more than
an hour with nothing heard, fix or ghost (`GHOST_HOLD_SILENCE_MS`), is now
shown at once. If its telemetry turns up, the slot becomes a fix in the
same grid square. Only the first ghost back skips the hold: the next one is
ten minutes behind it, so it is held as usual.

## Since: the track runs through the ones deep in a silence (2026-11-20)

PT-02 was heard without telemetry for two days over the Gulf of Alaska:
a last fix at 20:24 UTC on 18 Nov, a ghost in BO56 two and a half hours
later, one in CO45 the next afternoon, and no fix until 18:34 on the 20th
off Vancouver Island. While the ghosts were the newest reports they were
the dashed tail, as ever. The moment telemetry came back the tail went,
and the track ran from one fix straight to the other, 177 km from the
centre of BO56 and 271 km from CO45: the only two positions known in those
two days, and the track ignored both.

Such a ghost is now a **waypoint** (`waypoints` in `src/lib/ghosts.ts`),
and the track's curve across the silence passes through it (`flightLine`
in `src/lib/basemap.ts`). The track stays the solid line it is everywhere
else: a night with nothing heard is already drawn solid as the best guess
across it, and a silence with squares in it is better known than that, not
worse. Nothing new is dashed.

A ghost moves the track only on all of these terms:

- **A fix before it and a fix after it, each at least two hours away.**
  Two hours is the silence the line already called a hole
  (`BEND_GAP_MS`). Of the 85 ghosts on the first eight flights, 74 were
  under an hour from a fix: a telemetry message lost beside fixes that say
  where the balloon was far better than a square does. Those stay rings
  beside the line and move nothing. A ghost newer than the last fix moves
  nothing either: it is the tail and the beacon, as ever, until a fix
  comes back to judge it by.
- **Its square at least 150 km**, one square, from the position before it
  on the line and from the fix after. A square's centre is up to 95 km
  from the balloon, and a line bent to reach a centre one square away
  would be drawing that error. It also makes one waypoint of a run of
  ghosts in one square.
- **Inside the corridor the two fixes allow**: the way round by the ghost
  no more than 1.5 times the straight way between them
  (`WAYPOINT_MAX_DETOUR`). Between fixes half a day to two and a half days
  apart, 95% of the balloon's own positions on these flights were within
  that; the rest were loops in slack air, and a true ghost out there stays
  a ring, which is all it was before.
- **Within reach** of both fixes at the 300 kt of `src/lib/spoof.ts`.
- **No sign of GPS spoofing near the silence**: no fix set aside as
  spoofed from six hours before the fix that starts it to six hours after
  the one that ends it. A Regular message carries whatever square the GPS
  was told, and with spoofing about a square proves nothing.
- **The ghosts of one silence agreeing**: if one cannot be reached from
  the one before it, something lied, there is no saying which, and the
  silence is drawn fix to fix.

The curve: a waypoint is a vertex like a fix. Its heading is the chord
from the position before it to the one after; a fix still takes its
heading from the fixes on its own side only.

**Distance** covered, and the distance record, go through the waypoints,
as Traquito's does; because a waypoint needs a fix after it, the figure
never runs ahead of the last fix. Where and when a crossing was made
(`src/lib/records.ts`) is read off the same line. Altitude, speed, the
charts, the forecast and every record read off one fix are untouched. So
is everything about the newest report: the beacon, the dashed tail, the
outlined square and the line under the cards are as they were. Nothing stored changed: the rule is applied where the line is
drawn.

`npm run waypoint-check` tests the rule at its edges; that on every
committed flight the line is point for point what it was outside a routed
silence; and the attack, a false square at every grid square on Earth in
every silence of every flight. Of 874,800 tried, 99.2% are refused, every
one accepted is inside the corridor, and none is accepted with a spoofed
fix heard in the silence.

What is left is what no rule can close: a false square that sits inside
the corridor, in a silence where nothing else was heard, is the same
message as a true one. It can pull the track sideways by at most 0.56 of
the distance between the two fixes. Tightening `WAYPOINT_MAX_DETOUR`
shrinks that and turns more true ghosts back into rings.
