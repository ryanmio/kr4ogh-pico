import pytest

from picolog.decode import (
    BME280_MESSAGE_VALUES,
    CALLSIGN_FIELD_VALUES,
    CALLSIGN_GROUP_VALUES,
    GRID_POWER_FIELD_VALUES,
    GRID_POWER_GROUP_VALUES,
    POWER_DBM_LEVELS,
    decode_bme280_slot3,
    decode_callsign,
    decode_grid_power,
)

BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def encode_callsign(id13: str, grid5: str, grid6: str, altitude_m: int) -> str:
    """Test-side encoder written independently from docs/telemetry-format.md:
    N = (grid5*24 + grid6) * 1068 + altitude/20, spread big-endian over
    callsign chars 2,4,5,6 with bases 36,26,26,26."""
    n = ((ord(grid5) - ord("A")) * 24 + (ord(grid6) - ord("A"))) * 1068 + altitude_m // 20
    c6 = n % 26
    n //= 26
    c5 = n % 26
    n //= 26
    c4 = n % 26
    c2 = n // 26
    az = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    return id13[0] + BASE36[c2] + id13[1] + az[c4] + az[c5] + az[c6]


def encode_grid_power(temp_c: int, volt_index: int, speed_knots: int,
                      gps_valid: int, hdr_type: int) -> tuple[str, int]:
    """N = (((temp*40 + volt)*42 + speed)*2 + gps)*2 + hdr, spread big-endian
    over grid1-4 + power with bases 18,18,10,10,19."""
    n = (((temp_c + 50) * 40 + volt_index) * 42 + speed_knots // 2) * 2 + gps_valid
    n = n * 2 + hdr_type
    p = n % 19
    n //= 19
    g4 = n % 10
    n //= 10
    g3 = n % 10
    n //= 10
    g2 = n % 18
    g1 = n // 18
    ar = "ABCDEFGHIJKLMNOPQR"
    return f"{ar[g1]}{ar[g2]}{g3}{g4}", POWER_DBM_LEVELS[p]


def test_group_value_spaces_fit_field_spaces():
    # If the unpack radixes disagree with these counts, the radix is wrong.
    assert CALLSIGN_GROUP_VALUES == 24 * 24 * 1068 == 615_168
    assert CALLSIGN_GROUP_VALUES <= 36 * 26 * 26 * 26  # callsign chars 2,4,5,6
    assert GRID_POWER_GROUP_VALUES == 90 * 40 * 42 * 2 * 2 == 604_800
    assert GRID_POWER_GROUP_VALUES <= 18 * 18 * 10 * 10 * 19  # grid + power


def test_published_s4_callsign_vector():
    # https://qrp-labs.com/flights/s4.html: callsign 0C0QQE decodes to
    # subsquare "IQ", altitude 80 m.
    t = decode_callsign("0C0QQE")
    assert t.grid5 == "I"
    assert t.grid6 == "Q"
    assert t.altitude_m == 80


def test_callsign_roundtrip_over_field_extremes():
    for grid5 in "AIX":
        for grid6 in "AQX":
            for alt in (0, 80, 8000, 21340):
                cs = encode_callsign("Q3", grid5, grid6, alt)
                t = decode_callsign(cs)
                assert (t.grid5, t.grid6, t.altitude_m) == (grid5, grid6, alt)


def test_grid_power_roundtrip_over_field_extremes():
    for temp in (-50, 0, 39):
        for volt_index in (0, 19, 20, 39):
            for speed in (0, 40, 82):
                for gps in (0, 1):
                    for hdr in (0, 1):
                        grid, power = encode_grid_power(temp, volt_index, speed, gps, hdr)
                        t = decode_grid_power(grid, power)
                        assert t.temperature_c == temp
                        assert t.speed_knots == speed
                        assert t.gps_valid == bool(gps)
                        assert t.hdr_type == hdr


def test_traquito_voltage_window():
    # Indexes 20-39 mean 3.00-3.95 V; indexes 0-19 mean 4.00-4.95 V
    # (https://traquito.github.io/pro/telemetry/basic/).
    cases = {0: 4.00, 19: 4.95, 20: 3.00, 39: 3.95}
    for volt_index, expected in cases.items():
        grid, power = encode_grid_power(0, volt_index, 0, 1, 1)
        assert decode_grid_power(grid, power).voltage_v == expected


def test_id13_characters_are_not_decoded():
    # Same data under different id13 must decode identically.
    a = decode_callsign(encode_callsign("00", "J", "K", 12000))
    b = decode_callsign(encode_callsign("Q9", "J", "K", 12000))
    assert a == b


def test_rejects_values_outside_basic_telemetry_space():
    # Callsign group: max legal packed value is 615,167; "ZZZZ" on chars
    # 2,4,5,6 packs to 632,735.
    with pytest.raises(ValueError):
        decode_callsign("0Z9ZZZ")
    # Grid+power group: RR99 + 60 dBm packs to 615,599 > 604,799.
    with pytest.raises(ValueError):
        decode_grid_power("RR99", 60)


def test_rejects_malformed_fields():
    with pytest.raises(ValueError):
        decode_callsign("KR4OGH")  # char 1 not in 0/1/Q: a real callsign
    with pytest.raises(ValueError):
        decode_callsign("0A0AA")  # too short
    with pytest.raises(ValueError):
        decode_grid_power("SA11", 10)  # grid char 1 beyond R
    with pytest.raises(ValueError):
        decode_grid_power("AB12", 11)  # 11 dBm is not a legal WSPR level


# ---------- Extended Telemetry: the Petrel BME280 message ----------

def encode_bme280_slot3(id13: str, temp_c: int, pressure_hpa: int, humidity_pct: int,
                        telemetry_type: int = 0, reserved: int = 0, hdr_type: int = 0,
                        slot: int = 3) -> tuple[str, str, int]:
    """Test-side encoder from the message definition: fields packed in
    reverse order of definition, then the headers in reverse order, so that
    unpacking peels HdrTelemetryType first and Humidity last."""
    n = humidity_pct
    n = n * 1101 + pressure_hpa
    n = n * 121 + (temp_c + 70)
    n = n * 5 + slot
    n = n * 16 + hdr_type
    n = n * 4 + reserved
    n = n * 2 + telemetry_type
    callsign_n, grid_power_n = divmod(n, GRID_POWER_FIELD_VALUES)
    p = grid_power_n % 19
    grid_power_n //= 19
    g4 = grid_power_n % 10
    grid_power_n //= 10
    g3 = grid_power_n % 10
    grid_power_n //= 10
    g2 = grid_power_n % 18
    g1 = grid_power_n // 18
    ar = "ABCDEFGHIJKLMNOPQR"
    c6 = callsign_n % 26
    callsign_n //= 26
    c5 = callsign_n % 26
    callsign_n //= 26
    c4 = callsign_n % 26
    c2 = callsign_n // 26
    az = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    callsign = id13[0] + BASE36[c2] + id13[1] + az[c4] + az[c5] + az[c6]
    return callsign, f"{ar[g1]}{ar[g2]}{g3}{g4}", POWER_DBM_LEVELS[p]


def test_bme280_message_fits_the_field_space():
    assert BME280_MESSAGE_VALUES == 2 * 4 * 16 * 5 * 121 * 1101 * 101
    assert BME280_MESSAGE_VALUES <= CALLSIGN_FIELD_VALUES * GRID_POWER_FIELD_VALUES


def test_known_good_petrel_message():
    # Bench reading recorded in the Petrel notes: 100ECD HP29 43 dBm is
    # slot 3, 27 C, 1016 hPa, 19 %.
    t = decode_bme280_slot3("100ECD", "HP29", 43)
    assert (t.temperature_c, t.pressure_hpa, t.humidity_pct) == (27, 1016, 19)
    assert not t.sensor_failed


def test_first_flight_message():
    # PT-01 at float, 2026-10-24 20:06 UTC: 100ABF NM72 53 dBm.
    t = decode_bme280_slot3("100ABF", "NM72", 53)
    assert (t.temperature_c, t.pressure_hpa, t.humidity_pct) == (-12, 252, 0)


def test_bme280_roundtrip_over_field_extremes():
    for temp in (-70, -40, 0, 50):
        for pressure in (0, 252, 1016, 1100):
            for humidity in (0, 19, 100):
                cs, grid, power = encode_bme280_slot3("10", temp, pressure, humidity)
                t = decode_bme280_slot3(cs, grid, power)
                assert (t.temperature_c, t.pressure_hpa, t.humidity_pct) == (temp, pressure, humidity)


def test_sensor_failure_sentinel():
    cs, grid, power = encode_bme280_slot3("10", -70, 0, 0)
    assert decode_bme280_slot3(cs, grid, power).sensor_failed


def test_bme280_rejects_other_headers():
    # Basic Telemetry's bit set, a reserved bit set, another message type,
    # another slot: each is somebody else's message, never a reading.
    for kw in ({"telemetry_type": 1}, {"reserved": 1}, {"hdr_type": 1},
               {"hdr_type": 15}, {"slot": 2}, {"slot": 4}):
        cs, grid, power = encode_bme280_slot3("10", 20, 1000, 50, **kw)
        with pytest.raises(ValueError):
            decode_bme280_slot3(cs, grid, power)


def test_bme280_rejects_values_outside_the_message_space():
    # 0Z9ZZZ RR99 60 is the largest value the fields can carry, far beyond
    # the message's 8.6e9.
    with pytest.raises(ValueError):
        decode_bme280_slot3("0Z9ZZZ", "RR99", 60)
    with pytest.raises(ValueError):
        decode_bme280_slot3("KR4OGH", "FM09", 13)  # a real callsign


def test_basic_telemetry_is_not_a_sensor_reading():
    # A real Basic Telemetry message has HdrTelemetryType 1 in the same bit.
    grid, power = encode_grid_power(10, 25, 20, 1, 1)
    with pytest.raises(ValueError):
        decode_bme280_slot3(encode_callsign("10", "J", "K", 10000), grid, power)
