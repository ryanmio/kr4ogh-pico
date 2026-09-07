from picolog.match import NAME, VERSION, fingerprint_match

SLOT = "2025-06-01 10:00:00"
TEL_SLOT = "2025-06-01 10:02:00"


def reg(rx, freq, time=SLOT):
    return {"id": 1, "time": time, "rx_sign": rx, "tx_sign": "N0CALL",
            "tx_loc": "FN41", "frequency": freq, "power": 13}


def tel(rx, freq, tx_sign="1Y4ABC", tx_loc="EK28", power=37, time=TEL_SLOT):
    return {"id": 2, "time": time, "rx_sign": rx, "tx_sign": tx_sign,
            "tx_loc": tx_loc, "frequency": freq, "power": power}


def test_constants_exist():
    assert NAME == "fingerprint"
    assert isinstance(VERSION, int)


def test_pairs_same_station_consecutive_slots_close_frequency():
    matches = fingerprint_match([reg("K1ABC", 14097061)],
                                [tel("K1ABC", 14097063)])
    assert len(matches) == 1
    assert matches[0].slot_utc == SLOT
    assert matches[0].rx_station_count == 1


def test_receiver_calibration_error_cancels():
    # A station 80 Hz off nominal still pairs: both its reports carry the
    # same error, and the comparison is spot-to-spot, not spot-to-nominal.
    matches = fingerprint_match([reg("BADCAL", 14097141)],
                                [tel("BADCAL", 14097143)])
    assert len(matches) == 1


def test_no_pair_when_frequencies_only_match_nominal():
    # Regular heard at +80 Hz by one station; telemetry at nominal by the
    # same station. Nominal-frequency matching would accept this; the
    # fingerprint must not.
    matches = fingerprint_match([reg("BADCAL", 14097141)],
                                [tel("BADCAL", 14097061)])
    assert matches == []


def test_requires_same_station():
    matches = fingerprint_match([reg("K1ABC", 14097061)],
                                [tel("W9XYZ", 14097061)])
    assert matches == []


def test_requires_consecutive_slot():
    matches = fingerprint_match(
        [reg("K1ABC", 14097061)],
        [tel("K1ABC", 14097061, time="2025-06-01 10:04:00")])
    assert matches == []


def test_counts_confirming_stations_and_picks_majority_payload():
    regs = [reg("A1AA", 14097060), reg("B2BB", 14097100), reg("C3CC", 14097055)]
    tels = [tel("A1AA", 14097061), tel("B2BB", 14097101),
            tel("C3CC", 14097056, tx_sign="1Z4ZZZ", tx_loc="AA00", power=0)]
    matches = fingerprint_match(regs, tels)
    assert len(matches) == 1
    assert matches[0].telemetry_spot["tx_sign"] == "1Y4ABC"
    assert matches[0].rx_station_count == 2


def test_ambiguous_slot_is_skipped_not_guessed():
    regs = [reg("A1AA", 14097060), reg("B2BB", 14097060)]
    tels = [tel("A1AA", 14097061),
            tel("B2BB", 14097061, tx_sign="1Z4ZZZ", tx_loc="AA00", power=0)]
    assert fingerprint_match(regs, tels) == []


def test_duplicate_reports_from_one_station_count_once():
    tels = [tel("A1AA", 14097061), tel("A1AA", 14097062)]
    matches = fingerprint_match([reg("A1AA", 14097060)], tels)
    assert len(matches) == 1
    assert matches[0].rx_station_count == 1


# ---------- Regular-only slots ----------

from picolog.match import regular_only_slots  # noqa: E402

LATER = "2025-06-01 10:10:00"


def test_unmatched_regular_slot_becomes_a_ghost():
    regs = [reg("K1ABC", 14097061), reg("W9XYZ", 14097070),
            reg("K1ABC", 14097061, time=LATER)]
    matches = fingerprint_match(regs, [tel("K1ABC", 14097063)])
    ghosts = regular_only_slots(regs, matches)
    assert [(g.slot_utc, g.grid4, g.rx_station_count) for g in ghosts] == [
        (LATER, "FN41", 1)]


def test_ghost_counts_distinct_stations_and_normalises_the_square():
    regs = [reg("K1ABC", 14097061), reg("K1ABC", 14097061),
            {**reg("W9XYZ", 14097070), "tx_loc": "fn41"}]
    ghosts = regular_only_slots(regs, [])
    assert [(g.grid4, g.rx_station_count) for g in ghosts] == [("FN41", 2)]


def test_ghost_square_is_put_to_a_vote():
    regs = [reg("A", 1), reg("B", 1), {**reg("C", 1), "tx_loc": "FN42"}]
    assert [g.grid4 for g in regular_only_slots(regs, [])] == ["FN41"]
    tied = [reg("A", 1), {**reg("C", 1), "tx_loc": "FN42"}]
    assert regular_only_slots(tied, []) == []
