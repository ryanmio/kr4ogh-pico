import pytest

from picolog.decode import (
    CALLSIGN_GROUP_VALUES,
    GRID_POWER_GROUP_VALUES,
    POWER_DBM_LEVELS,
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
