import json

from picolog.export_site import export
from picolog.store import Store

CONFIG = """
[site]
callsign = "N0CALL"

[[flights]]
flight_id = "F1"
callsign = "N0CALL"
band = "20m"
channel = 42
launch_utc = "2026-09-01 00:00:00"

[[flights]]
flight_id = "F0"
callsign = "N0CALL"
band = "20m"
channel = 41
active = false
"""


def test_tracks_are_named_by_callsign_and_stale_ones_go(tmp_path):
    (tmp_path / "flights.toml").write_text(CONFIG)
    tracks = tmp_path / "src" / "data" / "tracks"
    tracks.mkdir(parents=True)
    # Left behind by the repository this one was copied from: a flight of
    # theirs with the same id as ours, and one of ours that is parked.
    (tracks / "KR4OGH-F1.json").write_text('[{"utc":"2026-08-30 12:44:00"}]')
    (tracks / "N0CALL-F0.json").write_text("[]")
    with Store(tmp_path / "t.db"):
        pass

    export(tmp_path / "flights.toml", tmp_path / "t.db", tmp_path)

    assert sorted(p.name for p in tracks.iterdir()) == [
        "N0CALL-F1.ghosts.json", "N0CALL-F1.json"]
    assert json.loads((tracks / "N0CALL-F1.json").read_text()) == []
    assert json.loads((tracks / "N0CALL-F1.ghosts.json").read_text()) == []


def test_ghosts_are_exported_beside_the_track_and_pruned(tmp_path):
    (tmp_path / "flights.toml").write_text(CONFIG)
    tracks = tmp_path / "src" / "data" / "tracks"
    tracks.mkdir(parents=True)
    # Last export: a ghost at 00:10 and one at 00:20.
    (tracks / "N0CALL-F1.ghosts.json").write_text(json.dumps([
        {"utc": "2026-09-01 00:10:00", "grid4": "FN41", "lat": 41.5,
         "lon": -71.0, "rx_station_count": 1},
        {"utc": "2026-09-01 00:20:00", "grid4": "FN41", "lat": 41.5,
         "lon": -71.0, "rx_station_count": 1},
    ]))
    with Store(tmp_path / "t.db") as store:
        # Since then the 00:10 slot completed into a full fix ...
        store.upsert_telemetry([{
            "flight_id": "F1", "utc": "2026-09-01 00:10:00", "grid6": "FN41aa",
            "lat": 41.0, "lon": -71.9, "altitude_m": 1, "speed_knots": 0,
            "voltage_v": 4.0, "temperature_c": 0, "gps_valid": 1,
            "rx_station_count": 2, "regular_spot_id": 1, "telemetry_spot_id": 2,
            "matcher_name": "fingerprint", "matcher_version": 1}])
        # ... and a new ghost was heard at 00:30.
        store.replace_ghosts("F1", [{
            "flight_id": "F1", "utc": "2026-09-01 00:30:00", "grid4": "FN42",
            "lat": 42.5, "lon": -71.0, "rx_station_count": 3,
            "matcher_name": "fingerprint", "matcher_version": 1}])

    export(tmp_path / "flights.toml", tmp_path / "t.db", tmp_path)

    assert sorted(p.name for p in tracks.iterdir()) == [
        "N0CALL-F1.ghosts.json", "N0CALL-F1.json"]
    ghosts = json.loads((tracks / "N0CALL-F1.ghosts.json").read_text())
    assert [(g["utc"], g["grid4"], g["rx_station_count"]) for g in ghosts] == [
        ("2026-09-01 00:20:00", "FN41", 1),
        ("2026-09-01 00:30:00", "FN42", 3),
    ]
    assert set(ghosts[0]) == {"utc", "grid4", "lat", "lon", "rx_station_count"}


CLOSED = """
[site]
callsign = "N0CALL"

[[flights]]
flight_id = "F1"
callsign = "N0CALL"
band = "20m"
channel = 42
launch_utc = "2026-09-01 00:00:00"
end_utc = "2026-09-02 00:00:00"
status = "closed"
"""


def test_nothing_pulled_keeps_the_committed_track(tmp_path):
    # The scheduled run's database is a throwaway, and with every flight
    # closed the pull step creates nothing in it, not even the tables. The
    # export must still run, and must leave the committed track alone.
    (tmp_path / "flights.toml").write_text(CLOSED)
    tracks = tmp_path / "src" / "data" / "tracks"
    tracks.mkdir(parents=True)
    committed = [{"utc": "2026-09-01 12:00:00", "grid6": "FM19aa"}]
    (tracks / "N0CALL-F1.json").write_text(json.dumps(committed))

    export(tmp_path / "flights.toml", tmp_path / "never-pulled.db", tmp_path)

    assert json.loads((tracks / "N0CALL-F1.json").read_text()) == committed
    assert json.loads((tracks / "N0CALL-F1.ghosts.json").read_text()) == []


def test_sensor_fields_are_written_only_where_read(tmp_path):
    (tmp_path / "flights.toml").write_text(CONFIG)
    with Store(tmp_path / "t.db") as store:
        base = {"flight_id": "F1", "grid6": "FN41aa", "lat": 41.0, "lon": -71.9,
                "altitude_m": 1, "speed_knots": 0, "voltage_v": 4.0,
                "temperature_c": 0, "gps_valid": 1, "rx_station_count": 2,
                "regular_spot_id": 1, "telemetry_spot_id": 2,
                "matcher_name": "fingerprint", "matcher_version": 1}
        store.upsert_telemetry([
            {**base, "utc": "2026-09-01 00:10:00"},
            {**base, "utc": "2026-09-01 00:20:00", "pressure_hpa": 252,
             "board_temp_c": -12, "humidity_pct": 0, "sensor_spot_id": 9},
        ])
    export(tmp_path / "flights.toml", tmp_path / "t.db", tmp_path)
    track = json.loads((tmp_path / "src" / "data" / "tracks" / "N0CALL-F1.json").read_text())
    assert "pressure_hpa" not in track[0]
    assert (track[1]["pressure_hpa"], track[1]["board_temp_c"], track[1]["humidity_pct"]) == (252, -12, 0)
    assert "sensor_spot_id" not in track[1]


def _fix(utc, **extra):
    return {"flight_id": "F1", "utc": utc, "grid6": "FN41aa", "lat": 41.0, "lon": -71.9,
            "altitude_m": 10800, "speed_knots": 60, "voltage_v": 4.0,
            "temperature_c": 0, "gps_valid": 1, "rx_station_count": 1,
            "regular_spot_id": 1, "telemetry_spot_id": 2,
            "matcher_name": "fingerprint", "matcher_version": 1, **extra}


def test_the_tier_is_written_only_on_an_inferred_point(tmp_path):
    """A confirmed fix looks exactly as every fix always did; an inferred
    one says so, with its reason (docs/cross-receiver-pairing.md)."""
    (tmp_path / "flights.toml").write_text(CONFIG)
    with Store(tmp_path / "t.db") as store:
        store.upsert_telemetry([
            _fix("2026-09-01 00:10:00", tier="confirmed", pressure_hpa=250,
                 board_temp_c=-10, humidity_pct=0, sensor_tier="confirmed"),
            _fix("2026-09-01 00:20:00", tier="inferred", pairing="cross-receiver; why",
                 matcher_name="cross-receiver"),
            _fix("2026-09-01 00:30:00", tier="confirmed", pressure_hpa=251,
                 board_temp_c=-11, humidity_pct=0, sensor_tier="inferred",
                 sensor_pairing="cross-receiver; sensor why"),
        ])
        store.replace_ghosts("F1", [{
            "flight_id": "F1", "utc": "2026-09-01 00:40:00", "grid4": "FN41",
            "lat": 41.5, "lon": -71.0, "rx_station_count": 1,
            "matcher_name": "cross-receiver", "matcher_version": 1,
            "pressure_hpa": 252, "board_temp_c": -12, "humidity_pct": 0,
            "sensor_tier": "inferred", "sensor_pairing": "g why", "grid_source": "neighbours"}])
    export(tmp_path / "flights.toml", tmp_path / "t.db", tmp_path)
    tracks = tmp_path / "src" / "data" / "tracks"
    track = json.loads((tracks / "N0CALL-F1.json").read_text())
    assert not {"tier", "pairing", "sensor_tier", "sensor_pairing"} & set(track[0])
    assert (track[1]["tier"], track[1]["pairing"]) == ("inferred", "cross-receiver; why")
    assert "tier" not in track[2] and track[2]["sensor_tier"] == "inferred"
    (ghost,) = json.loads((tracks / "N0CALL-F1.ghosts.json").read_text())
    assert ghost == {"utc": "2026-09-01 00:40:00", "grid4": "FN41", "lat": 41.5,
                     "lon": -71.0, "rx_station_count": 1, "pressure_hpa": 252,
                     "board_temp_c": -12, "humidity_pct": 0, "sensor_tier": "inferred",
                     "sensor_pairing": "g why", "grid_source": "neighbours"}


def test_a_rejudged_inferred_point_is_withdrawn_not_merged_back(tmp_path):
    """The export merges into the committed track and never drops a point
    on its own. An inferred point the database has since looked at again
    and not accepted is the exception: it is withdrawn. A confirmed point,
    and an inferred one the database says nothing about, are kept."""
    (tmp_path / "flights.toml").write_text(CONFIG)
    tracks = tmp_path / "src" / "data" / "tracks"
    tracks.mkdir(parents=True)
    committed = [
        {"utc": "2026-09-01 00:10:00", "lat": 41.0, "lon": -71.9},
        {"utc": "2026-09-01 00:20:00", "lat": 41.0, "lon": -71.9, "tier": "inferred"},
        {"utc": "2026-09-01 00:30:00", "lat": 41.0, "lon": -71.9, "tier": "inferred"},
    ]
    (tracks / "N0CALL-F1.json").write_text(json.dumps(committed))
    from datetime import datetime

    def judged(window_start):
        with Store(tmp_path / "t.db") as store:
            store.conn.execute("DELETE FROM pulls")
            store.record_pull(datetime.fromisoformat(window_start),
                              datetime(2026, 9, 1, 6), 14, "regular:F1", "q", 0)
            store.replace_pairings("F1", [
                {"flight_id": "F1", "cycle_utc": "2026-09-01 00:20:00", "kind": "basic",
                 "outcome": "ambiguous", "reason": "2 messages pass", "spot_ids": "1,2"}])
        export(tmp_path / "flights.toml", tmp_path / "t.db", tmp_path)
        return [p["utc"] for p in json.loads((tracks / "N0CALL-F1.json").read_text())]

    # Pulled from 23:50 the day before: 00:20 is only half an hour in, and
    # the verdict may rest on a Regular this database never saw. Kept.
    assert judged("2026-08-31 23:51:00") == [p["utc"] for p in committed]
    # Pulled from midnight the day before: well inside. Withdrawn.
    assert judged("2026-08-31 00:00:00") == ["2026-09-01 00:10:00", "2026-09-01 00:30:00"]
