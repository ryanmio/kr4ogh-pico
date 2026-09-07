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
