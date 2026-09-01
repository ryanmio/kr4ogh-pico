# U4B / Traquito WSPR telemetry format

This document is the working spec for everything the decoder in `tool/picolog/decode.py`
implements. Every factual claim carries the URL it came from. Where sources disagree, the
disagreement is called out rather than smoothed over.

## Licensing constraint

The reference implementations — [traquito/WsprEncoded](https://github.com/traquito/WsprEncoded)
and [traquito/WsprEncodedPython](https://github.com/traquito/WsprEncodedPython) — are
AGPL-3.0. This repository will be published, so **neither library has been read, cloned,
vendored, or copied from**. Everything below is derived from the published format
documentation only:

- https://traquito.github.io/pro/telemetry/ (Type 1 message, big-number packing technique)
- https://traquito.github.io/pro/telemetry/encoding/uniform/ (uniform field encoding)
- https://traquito.github.io/pro/telemetry/basic/ (Basic Telemetry fields, Traquito behaviour)
- https://traquito.github.io/pro/telemetry/channels/ (channel dimensions, fingerprinting)
- https://traquito.github.io/channelmap/help/ (schedule, id13, channel map)
- https://qrp-labs.com/u4b/u4bdecoding.html (protocol author's account, history, matching)
- https://qrp-labs.com/flights/s4.html (the original protocol spec, with exact packing
  order and a worked example)
- https://wspr.live/ (database endpoint, schema, usage limits)

## The two-message scheme

A U4B-style tracker repeats a 10-minute cycle. In its first 2-minute slot it sends a
**Regular** WSPR Type 1 message: real callsign, real 4-character Maidenhead grid, power
field. In the next 2-minute slot it sends a **Telemetry** message: also structurally a
Type 1 message, but with telemetry data disguised in the callsign, grid, and power fields
(https://traquito.github.io/channelmap/help/, https://qrp-labs.com/flights/s4.html).

Neither message alone gives a full position report. The Regular message carries the
4-character grid; the Telemetry message carries the 5th and 6th grid characters plus
altitude, temperature, voltage, speed, and GPS status. Both must be received — and
correctly paired — to produce one full record
(https://qrp-labs.com/flights/s4.html, "% full reports" discussion).

## WSPR Type 1 field space

Legal values per field, from https://traquito.github.io/pro/telemetry/:

| Field      | Legal values | Count |
|------------|--------------|-------|
| Callsign 1 | 0, 1, Q      | 3     |
| Callsign 2 | 0-9, A-Z     | 36    |
| Callsign 3 | 0-9          | 10    |
| Callsign 4 | A-Z, space   | 27    |
| Callsign 5 | A-Z, space   | 27    |
| Callsign 6 | A-Z, space   | 27    |
| Grid 1     | A-R          | 18    |
| Grid 2     | A-R          | 18    |
| Grid 3     | 0-9          | 10    |
| Grid 4     | 0-9          | 10    |
| Power      | 19 levels    | 19    |

The 19 legal power levels are 0, 3, 7, 10, 13, 17, 20, 23, 27, 30, 33, 37, 40, 43, 47,
50, 53, 57, 60 dBm (https://qrp-labs.com/u4b/u4bdecoding.html: "the power levels can only
be 0, 3, 7, 10, 13, 17, 20, 23, etc to 60dBm"; count of 19 from
https://qrp-labs.com/flights/s4.html: "The power is base 19").

Callsign characters 1 and 3 are **not data**. They carry the channel's `id13` identifier
(https://traquito.github.io/pro/telemetry/basic/, "Callsign characters 1 and 3 are not
used for data encoding"). Character 1 is 0, 1, or Q — prefixes the ITU never allocates to
any country, which is what marks the message as telemetry rather than a real callsign
(https://qrp-labs.com/u4b/u4bdecoding.html).

## Basic Telemetry fields

From https://traquito.github.io/pro/telemetry/basic/:

| Field            | Unit    | Low | High   | Step | Count |
|------------------|---------|-----|--------|------|-------|
| Grid5            | char    | 0   | 23     | 1    | 24    |
| Grid6            | char    | 0   | 23     | 1    | 24    |
| Altitude         | meters  | 0   | 21,340 | 20   | 1068  |
| Temperature      | Celsius | -50 | 39     | 1    | 90    |
| Voltage          | volts   | 2   | 3.95   | 0.05 | 40    |
| Speed            | knots   | 0   | 82     | 2    | 42    |
| IsGpsValid       | bool    | 0   | 1      | 1    | 2     |
| HdrTelemetryType | enum    | 0   | 1      | 1    | 2     |

Grid5 and Grid6 encode the range A-X (24 letters) and extend the Regular message's
4-character grid to a 6-character grid (~3 x 3 mile resolution). HdrTelemetryType is
"Specified to be the value 1 = Standard" — a decoded value other than 1 means the message
is not Basic Telemetry (it is the bit G0UPL describes as repurposed "to indicate an
extended telemetry packet", https://qrp-labs.com/u4b/u4bdecoding.html).

Each field is a uniform field: `index = (value - low) / step`,
`value = low + index * step`, radix = `(high - low) / step + 1`
(https://traquito.github.io/pro/telemetry/encoding/uniform/).

## Mixed-radix packing — the big number

Values are combined into a single integer by repeated multiply-and-add: for values A
(radix Ra) then B (radix Rb), `N = (A * Rb) + B`; extraction is the mirror-image
mod-and-divide, last field out first (https://traquito.github.io/pro/telemetry/,
"Conversion to big number Stage"). That page explicitly does **not** give the field order
for a specific message ("do not spell out the precise technical specifics"). The order
comes from the protocol author's original spec at https://qrp-labs.com/flights/s4.html,
which https://qrp-labs.com/u4b/u4bdecoding.html confirms is still current: "The original
telemetry encoding protocol was described on the S4 flight page and has almost not
changed since then. The only change was in the interpretation of the battery voltage; and
the penultimate least significant bit, the 'GPS satellites' bit was repurposed to
indicate an extended telemetry packet."

### Encode group 1: callsign — Grid5, Grid6, Altitude

From https://qrp-labs.com/flights/s4.html:

    subsquare = grid5_index * 24 + grid6_index        # "IQ" = 8*24 + 16 = 208
    N1        = subsquare * 1068 + altitude_index     # altitude_index = meters / 20

Equivalently, most-significant first: Grid5 (radix 24), Grid6 (radix 24),
Altitude (radix 1068). Total value space: 24 * 24 * 1068 = **615,168**.

N1 is spread across callsign characters 2, 4, 5, 6, **most significant character first**,
with bases 36 (char 2: 0-9 then A-Z), 26, 26, 26 (chars 4-6: A-Z; space is not used):

    N1 = ((c2 * 26 + c4) * 26 + c5) * 26 + c6

Character space: 36 * 26^3 = 632,736 ≥ 615,168, so it fits.

This order is verified arithmetically against the worked example on the S4 page:
callsign `0C0QQE` → chars 2,4,5,6 = C(12), Q(16), Q(16), E(4) →
((12·26+16)·26+16)·26+4 = 222,148 = 208 · 1068 + 4 → subsquare "IQ", altitude 80 m —
exactly the values the page states.

### Encode group 2: grid + power — Temperature, Voltage, Speed, IsGpsValid, HdrTelemetryType

From https://qrp-labs.com/flights/s4.html (with the S4-era "Satellites" bit now
HdrTelemetryType and "GPS status" now IsGpsValid, per
https://qrp-labs.com/u4b/u4bdecoding.html and the field order on
https://traquito.github.io/pro/telemetry/basic/):

    N2 = (((temperature_index * 40 + voltage_index) * 42 + speed_index) * 2
          + is_gps_valid) * 2 + hdr_telemetry_type

Total value space: 90 * 40 * 42 * 2 * 2 = **604,800**.

N2 is spread across grid characters 1-4 and the power level, most significant first,
bases 18, 18, 10, 10, 19 ("encoded back into the 4-character locator and 19-level power
fields, which are 5 items with base 18, 18, 10, 10, 19 respectively" —
https://qrp-labs.com/flights/s4.html):

    N2 = (((g1 * 18 + g2) * 10 + g3) * 10 + g4) * 19 + power_index

Field space: 18 * 18 * 10 * 10 * 19 = 615,600 ≥ 604,800, so it fits.

### A discrepancy in the S4 worked example

The S4 page's grid+power example (`RG74 43` → temperature 36 C, battery 3.8 V, speed 0,
GPS ok, sats ok) decodes under the formula above to speed 0, both flag bits 1 — matching —
but temperature index 88 (= 38 C) and voltage index 17 (= 3.85 V under S4's 3.00 V-based
scale), where the page states 36 C and 3.8 V. The structural fields all agree; the two
analogue-sensor values differ by one to two steps. S4's temperature came from an analogue
sensor with its own calibration, so the page's stated values likely reflect the flight
spreadsheet's calibration rather than the ideal scale. The callsign-group example verifies
exactly, and Step 7 of this project verifies the full modern decode against the Traquito
decoder and a live flight before anything is frozen.

## Traquito-specific behaviour (differs from the generic spec)

From https://traquito.github.io/pro/telemetry/basic/:

- **Clamping, not rollover.** The generic spec rolls values over (index modulo radix);
  Traquito clamps to the field range at both ends. A temperature of 45 C transmits as 39 C.
- **Voltage window is 3.0-4.95 V.** Rollover makes the voltage field a repeating sequence
  of 2.0-3.95, 4.0-5.95, ... ranges. Traquito clamps to 3.0-4.95 V, which straddles the
  spec ranges: indexes 20-39 mean 3.00-3.95 V and indexes 0-19 mean 4.00-4.95 V.
  "Traquito Web also limits to this voltage range", so the decoder maps every received
  index into 3.0-4.95 V: `volts = 4.0 + index * 0.05` if index < 20, else
  `volts = 2.0 + index * 0.05`.
- **IsGpsValid is always true.** Traquito requires a GPS lock before sending Basic
  Telemetry and does not implement IsGpsValid=false.
- **Speed saturates at 82 knots.** Clamping applies to speed like every other
  field, and 82 kt (94 mph) is the top of the 42-value range. A pico in the jet
  stream regularly exceeds it, so a reported 82 means "82 or faster" and cannot
  be read as a measurement. The decoders here report the transmitted value
  unchanged — that is what was sent, and the stored record says what was sent.
  Recovering the real speed is a track-level job, done from the distance flown
  between fixes in `site/src/lib/speed.ts`; it is measured against the tracker's
  own GPS speed on a real flight in `site/dev/speed-check.ts`.
- **Temperature is the RP2040 die sensor** ("Traquito uses the onboard RP2040 temperature
  sensor for this measurement"), not external air temperature.

### Known gap in Flight 1 diagnosability

Because the temperature field is the RP2040 die temperature, **this program cannot
separate thermal failure from other loss modes for Flight 1**. Distinguishing "the
airframe got too cold" from "the electronics failed" requires external air temperature,
and bone-stock Traquito hardware cannot supply it. This is recorded as a known gap, not
worked around: the trackers fly stock firmware (see repo hard guards) and the die sensor
is what exists.

## The channel system — four dimensions

600 channels per band, from https://qrp-labs.com/u4b/u4bdecoding.html and
https://traquito.github.io/pro/telemetry/channels/:

1. **Callsign character 1** — 0, 1, or Q (3 values).
2. **Callsign character 3** — 0-9 (10 values). Together these form `id13`, the column
   headers 00-Q9 on the Channel Map.
3. **Start minute** — 5 possible 2-minute slots in the 10-minute cycle (0, 2, 4, 6, 8).
   The Regular message goes out at the start minute, Telemetry in the following slot
   (https://traquito.github.io/channelmap/help/).
4. **Frequency segment** — the 200 Hz WSPR sub-band is cut into five 40 Hz slices; the
   middle slice is skipped because casual operators cluster at the published center
   frequency, leaving 4 usable slices. On 20 m the four transmit frequencies are
   14,097,020 / 14,097,060 / 14,097,140 / 14,097,180 Hz
   (https://qrp-labs.com/u4b/u4bdecoding.html).

3 × 10 × 5 × 4 = 600 channels. Attribution of a telemetry spot therefore needs all four
of: callsign (of the Regular message), id13, timeslot, and frequency slice.

## The fingerprinting problem

Telemetry messages have no predictable callsign — every field except id13 is data. To
attribute one, you must pair it with a Regular message from the same tracker. The channel
gives you id13, the timeslot, and the nominal frequency slice — but **many WSPR receivers
are poorly calibrated**, and any receiver frequency error shifts the *reported* frequency.
A 50 Hz receiver error moves a spot into the neighbouring 40 Hz slice, attributing it to
someone else's flight (https://qrp-labs.com/u4b/u4bdecoding.html;
https://traquito.github.io/pro/telemetry/channels/).

Two published mitigations:

- **Fingerprinting** (Traquito, devised by KD2KDD): pair a Regular and a Telemetry spot
  when the *same receiving station* heard both in consecutive slots at nearly the same
  reported frequency. Receiver calibration error cancels because both reports pass
  through the same error. Limitation: it needs one station to hear both packets. Measured
  over VE3KCL's U4B-40 flight, that requirement lost 720 of 12,469 otherwise-recoverable
  records (~6%), concentrated where receiver density is low — over oceans
  (https://qrp-labs.com/u4b/u4bdecoding.html).
- **Receiver-error correction** (QRP Labs): cross-reference every report in a timeslot to
  estimate each receiver's calibration error, correct all reported frequencies, then
  attribute telemetry by corrected frequency slice directly. Recovers the ~6% but needs
  the full timeslot matrix (https://qrp-labs.com/u4b/u4bdecoding.html).

This tool implements fingerprinting first (`tool/picolog/match.py`) and stores raw spots
so a receiver-error-correction matcher can be added later without re-ingesting.
