# Partial spots: showing a Regular message with no Telemetry

Status: **not built.** Watching it across flights; build if it keeps costing
us the fixes that matter. Written 2026-08-31 after F1B's first sunset.

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

## If we build it

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
