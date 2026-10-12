from datetime import datetime, timedelta

import json

from picolog.config import load_flights
from picolog.run import chunks, newest_committed


def test_chunks_cover_the_window_exactly_once():
    start = datetime(2026, 8, 30, 12, 44)
    end = datetime(2026, 9, 20, 3, 0)
    windows = list(chunks(start, end, timedelta(days=7)))
    assert windows[0][0] == start and windows[-1][1] == end
    assert all(b - a <= timedelta(days=7) for a, b in windows)
    assert all(windows[i][1] == windows[i + 1][0] for i in range(len(windows) - 1))
    assert len(windows) == 3


def test_short_window_is_one_chunk():
    start = datetime(2026, 9, 1)
    assert list(chunks(start, start + timedelta(hours=26))) == \
        [(start, start + timedelta(hours=26))]


def test_empty_window_is_no_chunks():
    start = datetime(2026, 9, 1)
    assert list(chunks(start, start)) == []


def _flight(tmp_path):
    toml = tmp_path / "flights.toml"
    toml.write_text('[site]\ncallsign = "N0CALL"\n\n[[flights]]\nflight_id = "F1"\n'
                    'callsign = "N0CALL"\nband = "20m"\nchannel = 1\n'
                    'launch_utc = "2026-09-01 00:00:00"\n')
    return load_flights(str(toml))[0]


def test_newest_committed_reads_the_last_fix(tmp_path):
    flight = _flight(tmp_path)
    tracks = tmp_path / "src" / "data" / "tracks"
    tracks.mkdir(parents=True)
    (tracks / "N0CALL-F1.json").write_text(json.dumps(
        [{"utc": "2026-09-02 10:00:00"}, {"utc": "2026-09-03 18:36:00"}]))
    assert newest_committed(str(tmp_path), flight) == datetime(2026, 9, 3, 18, 36)


def test_newest_committed_is_none_without_a_track(tmp_path):
    flight = _flight(tmp_path)
    assert newest_committed(str(tmp_path), flight) is None
    tracks = tmp_path / "src" / "data" / "tracks"
    tracks.mkdir(parents=True)
    (tracks / "N0CALL-F1.json").write_text("[]")
    assert newest_committed(str(tmp_path), flight) is None
