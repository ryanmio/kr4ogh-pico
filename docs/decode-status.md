# Decode status

State of the decode stack as of 2026-08-19. Everything below was produced by
the code in `/tool` at this commit.

## Verification flight

Validated against **VE3VRO, 20 m, channel 343** (id13 "17", Regular at
minute 4, Telemetry at minute 6, nominal 14,097,020 Hz) over the full UTC day
**2026-08-18** — an active flight, mid-Pacific at the time, chosen from the
Traquito Flight Log and confirmed live in wspr.live data. That callsign was
flying a second concurrent flight (channel 285) the same day, which exercised
the channel-attribution path, not just the decode path.

Ingested through this repo's own stack (wspr.live pull -> SQLite -> fingerprint
match -> decode): 2,246 raw spots, 67 decoded telemetry records.

## Comparison against the Traquito Flight Search Dashboard

Same flight and dates opened in the dashboard
(`?band=20m&channel=343&callsign=VE3VRO&dtGte=2026-08-18&dtLte=2026-08-18`,
browser forced to UTC) and its spots table exported.

**Match rate: 67 of 67 rows identical** on every compared field: grid6,
altitude, speed, voltage, temperature, GPS-valid flag, per timeslot. Zero
slots decoded by only one side.

Rows that did not correspond one-to-one, with cause:

- **3 dashboard rows carry a Regular spot but no telemetry** (04:24, 04:44,
  16:54 UTC; the dashboard also shows such rows just outside the UTC day).
  These are partial reports — no station that heard the Regular message also
  heard the Telemetry message, or no telemetry was received at all — so there
  is nothing to decode. This tool's telemetry table only holds full records;
  the raw Regular spots are retained in `spots`. Not a discrepancy -- but see
  `docs/partial-spots.md`, which tracks whether the site should show these
  coarse positions the way the dashboard does.
- One methodological artifact worth recording: the dashboard interprets
  `dtGte`/`dtLte` in the **browser's local timezone** and prints timestamps
  without seconds. The first comparison ran with a US-Eastern browser and
  produced zero timestamp joins against my UTC-keyed rows. Re-running the
  dashboard with the browser timezone set to UTC aligned the windows exactly.
  Worth knowing before comparing anything else against dashboard exports.

Spot-check against https://traquito.github.io/pro/decode/ : 5 telemetry
messages from the day (first three and last two slots, e.g.
`1S7JFW EF95 20`) fed to the decode page. **5 of 5 identical** to this
decoder's output on every field, including the id13 "17" the page extracts.

The verified day is frozen in `tool/tests/vectors/basic_telemetry.json`
(2,246 raw spots + 67 expected records) and `tool/tests/test_vectors.py`
replays the full pipeline against it offline.

## Channel formula validation

The candidate 20 m mapping (id13 index = channel // 20; frequency index =
(channel % 20) // 5; start minute = (2 * (channel % 5) + 8) % 10; id13 order
00-09, 10-19, Q0-Q9; frequencies 14097020/060/140/180) reproduced all three
independently known points (channel 123 from the ChannelMap API doc; channels
206 and 348 from the operator's registrations).

Broad validation: 90 real flights sampled from the Traquito Flight Log across
all id13 groups, all four frequency slices, and all five start minutes;
checked against actual wspr.live spots. 67 had enough data to judge
(≥20 Regular spots in the predicted slot). Results:

- **id13 and start minute: 67 of 67 agree.** Test was strict fingerprint
  pairing — same receiver, Regular in the predicted minute, Telemetry with the
  predicted id13 exactly 2 minutes later, reported frequencies within 5 Hz.
  Every flight produced pairs (median in the hundreds); a wrong id13 or minute
  mapping would produce zero.
- **Frequency: 53 of 67 had median reported frequency within ±20 Hz of the
  predicted nominal.** The 14 outliers all still paired strongly, and their
  offsets are per-transmitter, not per-slice: e.g. KN4IUD's trackers ran 15-30
  Hz low against *different* predicted slices (020 and 140 and 180 channels
  alike), and KD2KDD's 20-40 Hz low. Accurately calibrated transmitters (N0LX,
  NQ1W, N0THA, KF8EEZ) landed within a few Hz of all four predicted slices.
  Conclusion: the outliers are transmitter offset — the channel map frequency
  is a nominal target, which is exactly why the matcher never matches against
  nominal.

The formula **held**, so `tool/picolog/channels_20m.csv` (600 rows) was
generated from it, frozen, and is the only thing the lookup path reads.

## Format issues encountered, and how they were resolved

- **The packing order is not on the Traquito pro pages.** The overview page
  explicitly declines to give "the precise technical specifics required to
  encode or decode a specific message." It was resolved from the protocol
  author's original published spec (https://qrp-labs.com/flights/s4.html),
  which https://qrp-labs.com/u4b/u4bdecoding.html states is still current.
  The S4 page's worked callsign example (`0C0QQE` -> "IQ", 80 m) verifies the
  order arithmetically, and the 67/67 + 5/5 results above confirm the modern
  implementation end to end.
- **The S4 page's grid+power worked example is internally inconsistent.**
  `RG74 43` decodes structurally as the page says (speed 0, both flag bits
  set) but to temperature index 88 and voltage index 17, where the page prints
  36 C and 3.8 V (expected: 38 C and 3.85 V on S4's own scales). Both are
  analogue-sensor fields on that 2015 flight; the page values likely reflect
  flight-spreadsheet calibration. Not used as a test vector; the modern
  decode is verified against Traquito's own tools instead.
- **G0UPL describes the repurposed bit as "the penultimate least significant
  bit"** while his S4 formula places the satellites bit (the one repurposed
  as HdrTelemetryType) in the least significant position, with GPS status
  penultimate. The S4 formula's placement — HdrTelemetryType last, IsGpsValid
  second-to-last, matching the field order on the Traquito Basic Telemetry
  page — is what verifies against real data.
- **Voltage window.** Implemented Traquito behaviour (3.0-4.95 V window:
  indexes 20-39 -> 3.00-3.95 V, 0-19 -> 4.00-4.95 V) rather than the generic
  spec's 2.0-3.95 V; confirmed against dashboard and decode-page output.
- **Temperature is the RP2040 die sensor**, not air temperature. Recorded in
  `docs/telemetry-format.md` as a known gap in Flight 1 diagnosability:
  thermal failure cannot be separated from other loss modes with this
  hardware, and it is not worked around.
- No case was found where a Traquito page contradicts the task prompt; the
  prompt's candidate channel formula and Traquito-behaviour notes matched the
  published pages and the live data everywhere they were tested.

## Not done here (by design)

CLI UX, program-condition flags, the diagnosis report, the website, and the
flight-archive exporter (specified in `docs/architecture.md`) are out of scope
for this layer and intentionally not started.
