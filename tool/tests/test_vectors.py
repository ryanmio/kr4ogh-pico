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

    for expected in vector["expected_telemetry"]:
        assert expected == got[expected["utc"]]
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
