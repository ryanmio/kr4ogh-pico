"""The decode step reads spots back from a store that holds every flight's
spots. Two flights on one channel with one callsign are told apart by when
they flew, so the read has to be bounded by the flight's span."""

from picolog.config import Flight
from picolog.pipeline import _span_clause, _spot_rows
from picolog.store import Store


def spot(spot_id, time):
    return {
        "id": str(spot_id), "time": time, "band": "14",
        "rx_sign": "AB1CDE", "rx_lat": 40.0, "rx_lon": -75.0, "rx_loc": "FN20",
        "tx_sign": "N0CALL", "tx_lat": 41.0, "tx_lon": -70.0, "tx_loc": "FN41",
        "distance": 400, "azimuth": 90, "rx_azimuth": 270,
        "frequency": "14097061", "power": 13, "snr": -21, "drift": 0,
        "version": "2.6.1", "code": 1,
    }


def rows_for(store, flight, shift_minutes=0):
    from datetime import timedelta
    where, params = _span_clause(flight, timedelta(minutes=shift_minutes))
    rows = _spot_rows(store, "tx_sign = ?" + where, ("N0CALL", *params))
    return sorted(r["time"] for r in rows)


def test_each_flight_reads_only_its_own_span(tmp_path):
    old = Flight("F1", "N0CALL", "20m", 348, active=False,
                 launch_utc="2026-08-30 12:44:00", end_utc="2026-09-01 12:00:00",
                 status="closed")
    new = Flight("F2", "N0CALL", "20m", 348,
                 launch_utc="2026-09-06 14:44:00")
    with Store(tmp_path / "t.db") as store:
        store.insert_spots([
            spot(1, "2026-08-30 12:40:00"),  # before F1 was heard
            spot(2, "2026-08-31 10:04:00"),  # F1
            spot(3, "2026-09-01 11:04:00"),  # F1, last fix
            spot(4, "2026-09-03 10:04:00"),  # nobody's: the gap between them
            spot(5, "2026-09-06 14:44:00"),  # F2, first fix
            spot(6, "2026-09-06 16:04:00"),  # F2
        ])
        assert rows_for(store, old) == ["2026-08-31 10:04:00", "2026-09-01 11:04:00"]
        assert rows_for(store, new) == ["2026-09-06 14:44:00", "2026-09-06 16:04:00"]


def test_telemetry_bound_follows_the_regular_by_two_minutes(tmp_path):
    # A fix at 11:58 sends its Telemetry at 12:00: an end of 12:00:00 must
    # still admit that second half, or the last fix decodes as nothing.
    flight = Flight("F1", "N0CALL", "20m", 348,
                    launch_utc="2026-08-30 12:44:00", end_utc="2026-09-01 12:00:00")
    with Store(tmp_path / "t.db") as store:
        store.insert_spots([spot(1, "2026-09-01 12:00:00"), spot(2, "2026-09-01 12:02:00")])
        assert rows_for(store, flight, shift_minutes=0) == []
        assert rows_for(store, flight, shift_minutes=2) == ["2026-09-01 12:00:00"]


def test_open_ended_flight_reads_everything(tmp_path):
    flight = Flight("F1", "N0CALL", "20m", 348)
    with Store(tmp_path / "t.db") as store:
        store.insert_spots([spot(1, "2020-01-01 00:00:00"), spot(2, "2030-01-01 00:00:00")])
        assert len(rows_for(store, flight)) == 2
