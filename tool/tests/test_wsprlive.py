from datetime import datetime, timedelta

import pytest

from picolog.wsprlive import regular_spots_query, telemetry_candidates_query

START = datetime(2025, 6, 1, 0, 0, 0)
END = datetime(2025, 6, 2, 0, 0, 0)


def test_regular_query_is_bounded_and_band_filtered():
    q = regular_spots_query("ve3kcl", 14, START, END)
    assert "time >= '2025-06-01 00:00:00'" in q
    assert "time < '2025-06-02 00:00:00'" in q
    assert "band = 14" in q
    assert "tx_sign = 'VE3KCL'" in q


def test_telemetry_query_filters_id13_minute_and_length():
    q = telemetry_candidates_query("Q4", 14, 6, START, END)
    assert "substring(tx_sign, 1, 1) = 'Q'" in q
    assert "substring(tx_sign, 3, 1) = '4'" in q
    assert "length(tx_sign) = 6" in q
    assert "toMinute(time) % 10 = 6" in q
    assert "band = 14" in q
    assert "frequency" not in q.split("FROM")[1]  # no frequency filter in SQL


def test_rejects_unbounded_or_oversized_windows():
    with pytest.raises(ValueError):
        regular_spots_query("VE3KCL", 14, END, START)  # inverted
    with pytest.raises(ValueError):
        regular_spots_query("VE3KCL", 14, START, START)  # empty
    with pytest.raises(ValueError):
        regular_spots_query("VE3KCL", 14, START, START + timedelta(days=40))


def test_rejects_malformed_id13_and_minute():
    with pytest.raises(ValueError):
        telemetry_candidates_query("X4", 14, 6, START, END)
    with pytest.raises(ValueError):
        telemetry_candidates_query("Q4", 14, 5, START, END)
