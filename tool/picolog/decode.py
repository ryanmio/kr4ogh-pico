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

Extended Telemetry, the second half of this file, uses the same two field
groups as one combined number. The only extended message decoded here is the
Petrel tracker's BME280 sensor reading in slot 3; see decode_bme280_slot3.
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
    # 0 to 82 in 2 kt steps, clamped by Traquito. 82 is the top of the field,
    # so it means "82 or faster" -- a pico in the jet stream sits there for
    # days. Reported as transmitted here on purpose; the site derives the real
    # speed from distance flown (src/lib/speed.ts), which needs the fixes
    # either side of a point and so cannot be done in a per-message decoder.
    speed_knots: int
    gps_valid: bool  # always True from a Jetpack; a lock is required to send
    hdr_type: int  # 1 = standard Basic Telemetry; anything else is not


# What the two field groups can hold at most, before any message's own value
# space is applied: callsign chars 2,4,5,6 at bases 36,26,26,26 and
# grid1-4 + power at bases 18,18,10,10,19 (https://traquito.github.io/pro/telemetry/).
CALLSIGN_FIELD_VALUES = 36 * 26 * 26 * 26  # 632,736
GRID_POWER_FIELD_VALUES = 18 * 18 * 10 * 10 * 19  # 615,600


def callsign_value(callsign: str) -> int:
    """The number packed into a telemetry callsign's data characters 2,4,5,6,
    most significant first. Validates the field, not the message: every
    telemetry message, basic or extended, is read through this.

    Raises ValueError if the callsign is not a well-formed telemetry callsign.
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
    return n


def grid_power_value(grid: str, power_dbm: int) -> int:
    """The number packed into a telemetry message's grid and power fields,
    most significant first. Raises ValueError if either field is malformed."""
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
    return n


def decode_callsign(callsign: str) -> CallsignTelemetry:
    """Unpack grid5, grid6, and altitude from a telemetry callsign.

    Raises ValueError if the callsign is not a well-formed telemetry callsign
    or the packed value falls outside the Basic Telemetry value space (a
    false WSPR decode, or not Basic Telemetry).
    """
    n = callsign_value(callsign)
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
    n = grid_power_value(grid, power_dbm)
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


def maidenhead_to_latlon(grid: str) -> tuple[float, float]:
    """Center of a 4- or 6-character Maidenhead locator box, in degrees.

    wspr.live's own lat/lon columns use the same convention ("the center of
    the reported locator box", https://wspr.live/).
    """
    g = grid.strip().upper()
    if len(g) not in (4, 6):
        raise ValueError(f"locator must be 4 or 6 chars: {grid!r}")
    lon = (ord(g[0]) - ord("A")) * 20.0 - 180.0 + int(g[2]) * 2.0
    lat = (ord(g[1]) - ord("A")) * 10.0 - 90.0 + int(g[3]) * 1.0
    if len(g) == 6:
        lon += (ord(g[4]) - ord("A")) * 5.0 / 60.0 + 2.5 / 60.0
        lat += (ord(g[5]) - ord("A")) * 2.5 / 60.0 + 1.25 / 60.0
    else:
        lon += 1.0
        lat += 0.5
    return round(lat, 5), round(lon, 5)


def _decode_voltage(index: int) -> float:
    # The spec field is 2.0-3.95 V with rollover; Traquito clamps to the
    # 3.0-4.95 V window, which the rollover arithmetic maps to indexes 20-39
    # (3.00-3.95 V) and 0-19 (4.00-4.95 V). Traquito Web decodes every index
    # into that window (https://traquito.github.io/pro/telemetry/basic/).
    if index < 20:
        return round(4.0 + index * 0.05, 2)
    return round(2.0 + index * 0.05, 2)


# ---------- Extended Telemetry: the Petrel BME280 message, slot 3 ----------
#
# An Extended Telemetry message packs the callsign group and the grid+power
# group into ONE number, callsign group most significant, and peels fields
# off it least significant first. Every extended message starts with four
# header fields; the user-defined fields follow in the order of the
# message definition (https://traquito.github.io/pro/telemetry/extended/).
#
#   HdrTelemetryType  radix 2   0 = extended (1 is Basic Telemetry's bit)
#   HdrRESERVED       radix 4   0
#   HdrType           radix 16  0 = user-defined
#   HdrSlot           radix 5   which of the five 2-minute slots carries it
#
# The Petrel tracker (https://github.com/ryanmio/petrel) sends its BME280
# reading in slot 3, the Regular message's slot plus six minutes, with this
# message definition, each a uniform field of step 1:
#
#   Temperature  -70 .. 50 C     radix 121   board temperature, not air
#   Pressure       0 .. 1100 hPa radix 1101  absolute, not sea-level adjusted
#   Humidity       0 .. 100 %    radix 101
#
# A reading of -70 / 0 / 0 is the tracker saying the sensor did not answer
# (the script's failure path sends the field minimums), never a measurement.
#
# Any other tracker's slot-3 message would pass the header checks and decode
# into nonsense here, so this is only applied to flights whose flights.toml
# entry says the tracker carries the sensor.

EXTENDED_HEADER_RADICES = (2, 4, 16, 5)  # HdrTelemetryType, HdrRESERVED, HdrType, HdrSlot
BME280_RADICES = (121, 1101, 101)  # Temperature, Pressure, Humidity
BME280_SLOT = 3
BME280_TEMPERATURE_LOW_C = -70

# Value space of the whole message: headers times fields, 8,611,405,440,
# well inside the 389,512,281,600 the two field groups can carry.
BME280_MESSAGE_VALUES = 2 * 4 * 16 * 5 * 121 * 1101 * 101


@dataclass(frozen=True)
class Bme280Telemetry:
    temperature_c: int  # board temperature, -70 to 50 C
    pressure_hpa: int  # absolute pressure, 0 to 1100 hPa
    humidity_pct: int  # relative humidity, 0 to 100 %

    @property
    def sensor_failed(self) -> bool:
        """The tracker was alive but the sensor did not answer."""
        return (self.temperature_c, self.pressure_hpa, self.humidity_pct) == (-70, 0, 0)


def decode_bme280_slot3(callsign: str, grid: str, power_dbm: int) -> Bme280Telemetry:
    """Unpack the Petrel BME280 reading from a slot-3 telemetry message.

    Raises ValueError if the fields are malformed, the packed value lies
    outside the message's value space, or the header is not an extended,
    user-defined, slot-3 message: the message is not this one.
    """
    n = callsign_value(callsign) * GRID_POWER_FIELD_VALUES + grid_power_value(grid, power_dbm)
    if n >= BME280_MESSAGE_VALUES:
        raise ValueError(f"value {n} outside the BME280 message space: "
                         f"{callsign!r} {grid!r} {power_dbm}")

    header = []
    for radix in EXTENDED_HEADER_RADICES:
        header.append(n % radix)
        n //= radix
    telemetry_type, reserved, hdr_type, slot = header
    if telemetry_type != 0:
        raise ValueError(f"not extended telemetry (HdrTelemetryType {telemetry_type}): {callsign!r}")
    if reserved != 0 or hdr_type != 0:
        raise ValueError(f"not a user-defined message (reserved {reserved}, type {hdr_type}): "
                         f"{callsign!r}")
    if slot != BME280_SLOT:
        raise ValueError(f"slot {slot}, not slot {BME280_SLOT}: {callsign!r}")

    fields = []
    for radix in BME280_RADICES:
        fields.append(n % radix)
        n //= radix
    temperature_index, pressure_hpa, humidity_pct = fields
    return Bme280Telemetry(
        temperature_c=BME280_TEMPERATURE_LOW_C + temperature_index,
        pressure_hpa=pressure_hpa,
        humidity_pct=humidity_pct,
    )
