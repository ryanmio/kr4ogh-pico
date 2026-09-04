from datetime import datetime, timedelta

from picolog.run import chunks


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
