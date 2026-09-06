import pytest

from picolog.config import ConfigError, load_flights, load_site
from picolog.decode import maidenhead_to_latlon

SITE = """
[site]
callsign = "n0call"
"""


def write(tmp_path, text):
    p = tmp_path / "flights.toml"
    p.write_text(text)
    return p


def test_load_flights(tmp_path):
    p = write(tmp_path, SITE + """
[[flights]]
flight_id = "T1"
callsign = "N0CALL"
band = "20m"
channel = 42
launch_utc = "2026-08-30 12:44:00"

[flights.tracker]
"Hardware" = "Traquito Jetpack"
"Channel" = 42

[[flights]]
flight_id = "T2"
callsign = "n0call"
band = "20m"
channel = 61
active = false
status = "closed"
close_reason = "silence >7 days"
""")
    flights = load_flights(p)
    assert [f.flight_id for f in flights] == ["T1", "T2"]
    assert flights[0].band_code == 14
    assert flights[0].active and flights[0].status == "live"
    assert flights[0].launch.isoformat() == "2026-08-30T12:44:00"
    # Label order is the file's; values arrive as text whatever they were.
    assert flights[0].tracker == {"Hardware": "Traquito Jetpack", "Channel": "42"}
    assert not flights[1].active
    assert flights[1].callsign == "N0CALL"
    assert flights[1].close_reason == "silence >7 days"
    assert flights[1].tracker is None and flights[1].launch is None


def test_load_site(tmp_path):
    site = load_site(write(tmp_path, SITE))
    assert site.callsign == "N0CALL"
    assert site.url is None and site.repo is None
    with pytest.raises(ConfigError, match=r"\[site\]"):
        load_site(write(tmp_path, "[[flights]]\nflight_id = 'x'\n"))


def test_duplicate_flight_ids_rejected(tmp_path):
    p = write(tmp_path, """
[[flights]]
flight_id = "T1"
callsign = "N0CALL"
band = "20m"
channel = 42

[[flights]]
flight_id = "T1"
callsign = "N0CALL"
band = "20m"
channel = 43
""")
    with pytest.raises(ConfigError, match="used twice"):
        load_flights(p)


@pytest.mark.parametrize("field, bad, words", [
    ("flight_id", '"F 1"', "flight_id"),
    ("callsign", '"not a call"', "does not look like a callsign"),
    ("band", '"40m"', "20 m is supported"),
    ("channel", "600", "0 to 599"),
    ("channel", '"348"', "0 to 599"),
    ("active", '"yes"', "true or false"),
    ("launch_utc", '"2026-08-30"', "must look like"),
    ("launch_utc", '"2026-13-30 12:44:00"', "not a real date"),
    ("status", '"done"', '"live" or "closed"'),
    ("balloon", '"x"', "unknown field"),
])
def test_bad_field_named_in_error(tmp_path, field, bad, words):
    good = {"flight_id": '"T1"', "callsign": '"N0CALL"', "band": '"20m"', "channel": "42"}
    good[field] = bad
    body = "[[flights]]\n" + "\n".join(f"{k} = {v}" for k, v in good.items())
    with pytest.raises(ConfigError, match=words) as err:
        load_flights(write(tmp_path, body))
    assert field in str(err.value)


def test_missing_and_malformed_file(tmp_path):
    with pytest.raises(ConfigError, match="not found"):
        load_flights(tmp_path / "nope.toml")
    with pytest.raises(ConfigError, match="not valid TOML"):
        load_flights(write(tmp_path, "[[flights]\n"))


def test_maidenhead_centers():
    # 4-char box center, wspr.live convention: IO90 is the south of England.
    lat, lon = maidenhead_to_latlon("IO90")
    assert (lat, lon) == (50.5, -1.0)
    # 6-char subsquare center sits inside its parent 4-char box.
    lat6, lon6 = maidenhead_to_latlon("IO90aa")
    assert 50.0 <= lat6 <= 51.0 and -2.0 <= lon6 <= 0.0
    assert lat6 == pytest.approx(50.0 + 1.25 / 60, abs=1e-4)
    assert lon6 == pytest.approx(-2.0 + 2.5 / 60, abs=1e-4)
    with pytest.raises(ValueError):
        maidenhead_to_latlon("IO9")


def test_end_utc_bounds_the_flight(tmp_path):
    p = write(tmp_path, SITE + """
[[flights]]
flight_id = "T1"
callsign = "N0CALL"
band = "20m"
channel = 42
launch_utc = "2026-08-30 12:44:00"
end_utc = "2026-09-01 12:00:00"
status = "closed"
""")
    f = load_flights(p)[0]
    assert f.end.isoformat() == "2026-09-01T12:00:00"
    from datetime import datetime
    # The clip is the overlap of the asked-for window and the flight's span.
    assert f.clip(datetime(2026, 8, 1), datetime(2026, 9, 6)) == \
        (datetime(2026, 8, 30, 12, 44), datetime(2026, 9, 1, 12))
    start, end = f.clip(datetime(2026, 9, 5), datetime(2026, 9, 6))
    assert end <= start  # nothing of this flight lies in that window


def test_end_before_launch_rejected(tmp_path):
    p = write(tmp_path, SITE + """
[[flights]]
flight_id = "T1"
callsign = "N0CALL"
band = "20m"
channel = 42
launch_utc = "2026-08-30 12:44:00"
end_utc = "2026-08-30 12:44:00"
""")
    with pytest.raises(ConfigError, match=r"T1\.end_utc.*not after"):
        load_flights(p)


def test_featured_must_name_a_shown_flight(tmp_path):
    flights = """
[[flights]]
flight_id = "T1"
callsign = "N0CALL"
band = "20m"
channel = 42

[[flights]]
flight_id = "T0"
callsign = "N0CALL"
band = "20m"
channel = 41
active = false
"""
    assert load_site(write(tmp_path, SITE + 'featured = "T1"\n' + flights)).featured == "T1"
    assert load_site(write(tmp_path, SITE + flights)).featured is None
    with pytest.raises(ConfigError, match=r"\[site\]\.featured.*T9"):
        load_site(write(tmp_path, SITE + 'featured = "T9"\n' + flights))
    with pytest.raises(ConfigError, match=r"\[site\]\.featured.*active = false"):
        load_site(write(tmp_path, SITE + 'featured = "T0"\n' + flights))
