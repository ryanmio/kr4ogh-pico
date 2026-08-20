"""Decode U4B/Traquito Basic Telemetry from WSPR Type 1 message fields.

Two independent unpack groups (see docs/telemetry-format.md for derivation and
sources):

  callsign chars 2,4,5,6  ->  grid5, grid6, altitude
  grid (4 chars) + power  ->  temperature, voltage, speed, gps_valid, hdr_type

Callsign characters 1 and 3 are the channel's id13 and carry no telemetry;
they are never fed to the unpack.

Packing order and bases are from the protocol author's published spec
(https://qrp-labs.com/flights/s4.html), still current per
https://qrp-labs.com/u4b/u4bdecoding.html. Field ranges and Traquito-specific
behaviour (clamping, the 3.0-4.95 V voltage window, IsGpsValid always true)
are from https://traquito.github.io/pro/telemetry/basic/.

Implemented behaviour is Traquito's: values were CLAMPED at encode time, not
rolled over, so a decoded boundary value (e.g. altitude 21,340 m) may mean
"at or beyond the boundary".
"""

from dataclasses import dataclass

# Value spaces of the two encode groups. If an unpack disagrees with these,
# its radix is wrong (see tests).
CALLSIGN_GROUP_VALUES = 24 * 24 * 1068  # grid5 * grid6 * altitude = 615,168
GRID_POWER_GROUP_VALUES = 90 * 40 * 42 * 2 * 2  # 604,800

# The 19 legal WSPR power levels in dBm (https://qrp-labs.com/flights/s4.html:
# "0, 3, 7, 10, 13, 17 etc. up to 60dBm ... The power is base 19").
POWER_DBM_LEVELS = (0, 3, 7, 10, 13, 17, 20, 23, 27, 30, 33, 37, 40, 43, 47,
                    50, 53, 57, 60)

_BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


@dataclass(frozen=True)
class CallsignTelemetry:
    grid5: str  # 5th Maidenhead character, A-X
    grid6: str  # 6th Maidenhead character, A-X
    altitude_m: int  # 0 to 21,340 in 20 m steps, clamped by Traquito


@dataclass(frozen=True)
class GridPowerTelemetry:
    temperature_c: int
    """RP2040 die temperature, -50 to +39 C in 1 C steps.

    This is the tracker's internal die sensor
    (https://traquito.github.io/pro/telemetry/basic/), NOT external air
    temperature. Separating thermal failure from other loss modes requires
    external temperature, which this hardware cannot supply; that gap is
    recorded in docs/telemetry-format.md.
    """
    voltage_v: float  # 3.00 to 4.95 V in 0.05 V steps (Traquito window)
    speed_knots: int  # 0 to 82 in 2 kt steps, clamped by Traquito
    gps_valid: bool  # always True from a Jetpack; a lock is required to send
    hdr_type: int  # 1 = standard Basic Telemetry; anything else is not


def decode_callsign(callsign: str) -> CallsignTelemetry:
    """Unpack grid5, grid6, and altitude from a telemetry callsign.

    Raises ValueError if the callsign is not a well-formed telemetry callsign
    or the packed value falls outside the Basic Telemetry value space (a
    false WSPR decode, or not Basic Telemetry).
    """
    cs = callsign.strip().upper()
    if len(cs) != 6:
        raise ValueError(f"telemetry callsign must be 6 chars: {callsign!r}")
    if cs[0] not in "01Q" or not cs[2].isdigit():
        raise ValueError(f"not a telemetry callsign (id13 malformed): {callsign!r}")

    # Characters 1 and 3 are id13 and are deliberately not decoded here.
    c2, c4, c5, c6 = cs[1], cs[3], cs[4], cs[5]
    if c2 not in _BASE36:
        raise ValueError(f"callsign char 2 out of range: {callsign!r}")
    for c in (c4, c5, c6):
        if not "A" <= c <= "Z":
            raise ValueError(f"callsign chars 4-6 must be A-Z: {callsign!r}")

    n = _BASE36.index(c2)
    for c in (c4, c5, c6):
        n = n * 26 + (ord(c) - ord("A"))

    if n >= CALLSIGN_GROUP_VALUES:
        raise ValueError(f"callsign value {n} outside Basic Telemetry space: {callsign!r}")

    altitude_index = n % 1068
    subsquare = n // 1068
    grid6 = subsquare % 24
    grid5 = subsquare // 24
    return CallsignTelemetry(
        grid5=chr(ord("A") + grid5),
        grid6=chr(ord("A") + grid6),
        altitude_m=altitude_index * 20,
    )


def decode_grid_power(grid: str, power_dbm: int) -> GridPowerTelemetry:
    """Unpack temperature, voltage, speed, gps_valid, hdr_type from the
    telemetry message's 4-character grid field and power field.

    Raises ValueError if the fields are malformed or the packed value falls
    outside the Basic Telemetry value space.
    """
    g = grid.strip().upper()
    if len(g) != 4 or not ("A" <= g[0] <= "R" and "A" <= g[1] <= "R"
                           and g[2].isdigit() and g[3].isdigit()):
        raise ValueError(f"not a WSPR Type 1 grid: {grid!r}")
    if power_dbm not in POWER_DBM_LEVELS:
        raise ValueError(f"not a legal WSPR power level: {power_dbm!r}")

    n = ord(g[0]) - ord("A")
    n = n * 18 + (ord(g[1]) - ord("A"))
    n = n * 10 + int(g[2])
    n = n * 10 + int(g[3])
    n = n * 19 + POWER_DBM_LEVELS.index(power_dbm)

    if n >= GRID_POWER_GROUP_VALUES:
        raise ValueError(f"grid+power value {n} outside Basic Telemetry space: "
                         f"{grid!r} {power_dbm}")

    hdr_type = n % 2
    n //= 2
    gps_valid = n % 2
    n //= 2
    speed_index = n % 42
    n //= 42
    voltage_index = n % 40
    temperature_index = n // 40

    return GridPowerTelemetry(
        temperature_c=-50 + temperature_index,
        voltage_v=_decode_voltage(voltage_index),
        speed_knots=speed_index * 2,
        gps_valid=bool(gps_valid),
        hdr_type=hdr_type,
    )


def _decode_voltage(index: int) -> float:
    # The spec field is 2.0-3.95 V with rollover; Traquito clamps to the
    # 3.0-4.95 V window, which the rollover arithmetic maps to indexes 20-39
    # (3.00-3.95 V) and 0-19 (4.00-4.95 V). Traquito Web decodes every index
    # into that window (https://traquito.github.io/pro/telemetry/basic/).
    if index < 20:
        return round(4.0 + index * 0.05, 2)
    return round(2.0 + index * 0.05, 2)
