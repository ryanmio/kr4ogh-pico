import pytest

from picolog.config import load_flights
from picolog.decode import maidenhead_to_latlon


def test_load_flights(tmp_path):
    p = tmp_path / "flights.toml"
    p.write_text("""
[[flights]]
flight_id = "T1"
callsign = "N0CALL"
band = "20m"
channel = 42

[[flights]]
flight_id = "T2"
callsign = "N0CALL"
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
    assert not flights[1].active
    assert flights[1].close_reason == "silence >7 days"


def test_duplicate_flight_ids_rejected(tmp_path):
    p = tmp_path / "flights.toml"
    p.write_text("""
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
    with pytest.raises(ValueError):
        load_flights(p)


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
