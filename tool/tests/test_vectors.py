"""End-to-end test against frozen real-flight data.

The vector file holds one full UTC day of raw wspr.live spots for a real
flight, plus the decoded output that was verified row-by-row against the
Traquito Flight Search Dashboard and spot-checked against the Traquito decode
page. No network: everything runs from the frozen file.
"""

import json
from pathlib import Path

import pytest

from picolog.config import Flight
from picolog.pipeline import rebuild_flight_telemetry
from picolog.store import Store

VECTOR_PATH = Path(__file__).parent / "vectors" / "basic_telemetry.json"
PETREL_PATH = Path(__file__).parent / "vectors" / "petrel_slot3.json"

NO_SENSOR = {"pressure_hpa": None, "board_temp_c": None, "humidity_pct": None,
             "sensor_spot_id": None}


@pytest.fixture(scope="module")
def vector():
    return json.loads(VECTOR_PATH.read_text())


def test_full_pipeline_reproduces_verified_day(vector, tmp_path_factory):
    store = Store(tmp_path_factory.mktemp("db") / "vector.db")
    assert store.insert_spots(vector["raw_spots"]) == len(vector["raw_spots"])

    flight = Flight(**vector["flight"])
    written = rebuild_flight_telemetry(store, flight)
    assert written == len(vector["expected_telemetry"])

    got = {}
    cur = store.conn.execute("SELECT * FROM telemetry ORDER BY utc")
    columns = [d[0] for d in cur.description]
    for row in cur.fetchall():
        rec = dict(zip(columns, row))
        got[rec["utc"]] = rec

    # A stock tracker: the sensor columns exist on every row and hold nothing.
    for expected in vector["expected_telemetry"]:
        assert got[expected["utc"]] == {**expected, **NO_SENSOR}
    store.close()


def test_regular_only_slots_become_ghosts(vector, tmp_path_factory):
    # The day's Regular-only slots, which docs/decode-status.md counted
    # against the dashboard. dev/verify-port.ts holds the same list.
    store = Store(tmp_path_factory.mktemp("db") / "vector.db")
    store.insert_spots(vector["raw_spots"])
    rebuild_flight_telemetry(store, Flight(**vector["flight"]))
    rows = store.conn.execute(
        "SELECT utc, grid4, lat, lon, rx_station_count FROM ghosts ORDER BY utc"
    ).fetchall()
    assert rows == [
        ("2026-08-18 04:44:00", "AN71", 41.5, -165.0, 22),
        ("2026-08-18 16:54:00", "BN35", 45.5, -153.0, 13),
    ]
    fixed = {r[0] for r in store.conn.execute("SELECT utc FROM telemetry")}
    assert not fixed & {r[0] for r in rows}
    store.close()


def test_rebuild_is_idempotent(vector, tmp_path_factory):
    store = Store(tmp_path_factory.mktemp("db") / "vector.db")
    store.insert_spots(vector["raw_spots"])
    flight = Flight(**vector["flight"])
    first = rebuild_flight_telemetry(store, flight)
    second = rebuild_flight_telemetry(store, flight)
    assert first == second
    count = store.conn.execute("SELECT count(*) FROM telemetry").fetchone()[0]
    assert count == first
    store.close()


# ---------- the Petrel sensor message ----------

@pytest.fixture(scope="module")
def petrel():
    return json.loads(PETREL_PATH.read_text())


def _telemetry_rows(store):
    cur = store.conn.execute("SELECT * FROM telemetry ORDER BY utc")
    columns = [d[0] for d in cur.description]
    return {row[1]: dict(zip(columns, row)) for row in cur.fetchall()}


def test_petrel_slice_reproduces_sensor_readings(petrel, tmp_path_factory):
    store = Store(tmp_path_factory.mktemp("db") / "petrel.db")
    assert store.insert_spots(petrel["raw_spots"]) == len(petrel["raw_spots"])
    flight = Flight(**petrel["flight"])
    assert flight.sensor == "bme280"
    written = rebuild_flight_telemetry(store, flight)
    assert written == len(petrel["expected_telemetry"])
    got = _telemetry_rows(store)
    for expected in petrel["expected_telemetry"]:
        assert got[expected["utc"]] == expected
    # The slice was chosen so that the reading rode on every fix; the
    # pressure falls monotonically through the climb.
    pressures = [r["pressure_hpa"] for r in (got[e["utc"]] for e in petrel["expected_telemetry"])]
    assert all(p is not None for p in pressures)
    assert pressures == sorted(pressures, reverse=True)
    store.close()


def test_without_the_sensor_declared_the_same_spots_decode_to_nulls(petrel, tmp_path_factory):
    # The slot-3 message is only read for a flight that says it carries the
    # sensor: another tracker's slot 3 would decode into nonsense.
    store = Store(tmp_path_factory.mktemp("db") / "petrel.db")
    store.insert_spots(petrel["raw_spots"])
    flight = Flight(**{**petrel["flight"], "sensor": None})
    rebuild_flight_telemetry(store, flight)
    for row in _telemetry_rows(store).values():
        assert {k: row[k] for k in NO_SENSOR} == NO_SENSOR
    store.close()
