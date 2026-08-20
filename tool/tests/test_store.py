from datetime import datetime

import pytest
import sqlite3

from picolog.store import Store

T0 = datetime(2025, 6, 1, 0, 0, 0)
T1 = datetime(2025, 6, 1, 6, 0, 0)
T2 = datetime(2025, 6, 1, 12, 0, 0)
T3 = datetime(2025, 6, 2, 0, 0, 0)


def spot_row(spot_id, **overrides):
    row = {
        "id": str(spot_id),  # wire format: ClickHouse JSON sends UInt64 as str
        "time": "2025-06-01 10:04:00", "band": "14",
        "rx_sign": "AB1CDE", "rx_lat": 40.0, "rx_lon": -75.0, "rx_loc": "FN20",
        "tx_sign": "1Y4ABC", "tx_lat": 41.0, "tx_lon": -70.0, "tx_loc": "FN41",
        "distance": 400, "azimuth": 90, "rx_azimuth": 270,
        "frequency": "14097061", "power": 13, "snr": -21, "drift": 0,
        "version": "2.6.1", "code": 1,
    }
    row.update(overrides)
    return row


def telemetry_row(flight_id, utc, **overrides):
    rec = {
        "flight_id": flight_id, "utc": utc, "grid6": "FN41xk",
        "lat": 41.4, "lon": -70.0, "altitude_m": 9000, "speed_knots": 40,
        "voltage_v": 4.1, "temperature_c": -3, "gps_valid": 1,
        "rx_station_count": 7, "regular_spot_id": 1, "telemetry_spot_id": 2,
        "matcher_name": "fingerprint", "matcher_version": 1,
    }
    rec.update(overrides)
    return rec


def test_spot_insert_is_idempotent_and_typed(tmp_path):
    with Store(tmp_path / "t.db") as s:
        assert s.insert_spots([spot_row(101), spot_row(102)]) == 2
        assert s.insert_spots([spot_row(102), spot_row(103)]) == 1
        rows = s.conn.execute(
            "SELECT id, frequency FROM spots ORDER BY id").fetchall()
        assert rows == [(101, 14097061), (102, 14097061), (103, 14097061)]


def test_spots_are_append_only(tmp_path):
    with Store(tmp_path / "t.db") as s:
        s.insert_spots([spot_row(1)])
        with pytest.raises(sqlite3.IntegrityError):
            s.conn.execute("UPDATE spots SET snr = 0 WHERE id = 1")
        with pytest.raises(sqlite3.IntegrityError):
            s.conn.execute("DELETE FROM spots WHERE id = 1")


def test_telemetry_upsert_overwrites_on_flight_and_utc(tmp_path):
    with Store(tmp_path / "t.db") as s:
        s.upsert_telemetry([telemetry_row("X1", "2025-06-01 10:00:00")])
        s.upsert_telemetry([telemetry_row("X1", "2025-06-01 10:00:00",
                                          altitude_m=9020, matcher_version=2)])
        rows = s.conn.execute(
            "SELECT altitude_m, matcher_version FROM telemetry").fetchall()
        assert rows == [(9020, 2)]

        s.clear_telemetry()
        assert s.conn.execute("SELECT count(*) FROM telemetry").fetchone() == (0,)


def test_uncovered_windows_distinguish_unqueried_from_silent(tmp_path):
    with Store(tmp_path / "t.db") as s:
        kind = "regular:X1"
        s.record_pull(T0, T1, 14, kind, "SELECT ...", 12)
        s.record_pull(T2, T3, 14, kind, "SELECT ...", 0)

        gaps = s.uncovered_windows(14, kind, T0, T3)
        assert gaps == [("2025-06-01 06:00:00", "2025-06-01 12:00:00")]

        # the T2..T3 pull returned 0 rows but DID cover the window:
        # that stretch is genuine silence, not an unknown
        assert s.uncovered_windows(14, kind, T2, T3) == []

        # different query kind has no coverage at all
        assert s.uncovered_windows(14, "regular:X2", T0, T1) == [
            ("2025-06-01 00:00:00", "2025-06-01 06:00:00")]


def test_uncovered_windows_merges_overlapping_pulls(tmp_path):
    with Store(tmp_path / "t.db") as s:
        kind = "telemetry:X1"
        s.record_pull(T0, T2, 14, kind, "q", 5)
        s.record_pull(T1, T3, 14, kind, "q", 5)
        assert s.uncovered_windows(14, kind, T0, T3) == []
