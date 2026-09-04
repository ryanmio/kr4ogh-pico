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

    assert sorted(p.name for p in tracks.iterdir()) == ["N0CALL-F1.json"]
    assert json.loads((tracks / "N0CALL-F1.json").read_text()) == []
