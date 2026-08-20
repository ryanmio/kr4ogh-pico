from picolog.channels import channel_table_20m


def test_independently_known_points():
    table = channel_table_20m()

    # Traquito ChannelMap API doc example:
    # https://traquito.github.io/pro/telemetry/code/channelmap/
    ch = table[123]
    assert ch.id13 == "06"
    assert ch.start_minute == 4
    assert ch.frequency_hz == 14097020

    # Operator's registered flights, confirmed on the live Channel Map.
    ch = table[206]
    assert ch.start_minute == 0
    assert ch.frequency_hz == 14097060

    ch = table[348]
    assert ch.start_minute == 4
    assert ch.frequency_hz == 14097060


def test_table_is_complete_and_bijective():
    table = channel_table_20m()
    assert len(table) == 600
    assert sorted(table) == list(range(600))
    # 30 id13 values x 5 minutes x 4 frequencies: every combination exactly once
    combos = {(c.id13, c.start_minute, c.frequency_hz) for c in table.values()}
    assert len(combos) == 600


def test_field_domains():
    table = channel_table_20m()
    for c in table.values():
        assert c.id13[0] in "01Q"
        assert c.id13[1] in "0123456789"
        assert c.start_minute in (0, 2, 4, 6, 8)
        assert c.frequency_hz in (14097020, 14097060, 14097140, 14097180)
        assert c.telemetry_minute == (c.start_minute + 2) % 10
