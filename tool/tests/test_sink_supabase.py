from picolog.sink_supabase import push_telemetry, remote_telemetry_row


def local_record():
    return {
        "flight_id": "T1", "utc": "2026-08-18 00:04:00", "grid6": "AM49tk",
        "lat": 39.42917, "lon": -170.375, "altitude_m": 13520,
        "speed_knots": 50, "voltage_v": 4.05, "temperature_c": -28,
        "gps_valid": 1, "rx_station_count": 3,
        "regular_spot_id": 11, "telemetry_spot_id": 12,
        "matcher_name": "fingerprint", "matcher_version": 1,
    }


def test_remote_row_shape():
    row = remote_telemetry_row(local_record())
    assert row["utc"] == "2026-08-18T00:04:00Z"  # explicit UTC
    assert row["speed_kt"] == 50  # remote column name
    assert row["gps_valid"] is True  # real boolean
    # local provenance columns stay local
    assert "regular_spot_id" not in row
    assert "telemetry_spot_id" not in row
    assert "speed_knots" not in row


def test_push_without_credentials_fails_loudly_but_non_fatally(monkeypatch, capsys):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    ok = push_telemetry([local_record()])
    assert ok is False  # no exception escaped
    assert "non-fatal" in capsys.readouterr().err
