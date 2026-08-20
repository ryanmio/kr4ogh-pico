"""Write-only push to the Supabase cache.

Supabase is a hot cache for the public site. It is not the flight record (the
local SQLite file is) and not a backup (the free tier has zero backup
retention). One direction only: nothing in the tool ever reads from it, and it
can be absent, broken, or paused with zero effect on the record.

The push is idempotent: upsert on the remote primary keys, safe to re-run over
any window, never deletes. Re-running after a matcher change overwrites rows
with the newer matcher_name/matcher_version.

Failure contract: the push fails loudly (full error on stderr, False returned)
but non-fatally — it must never take the ingest run down with it.
"""

import os
import sys

import requests

from .config import Flight

_CHUNK_ROWS = 500
_TIMEOUT_S = 30.0


def push_flights(flights: list[Flight]) -> bool:
    rows = [{
        "flight_id": f.flight_id,
        "callsign": f.callsign,
        "channel": f.channel,
        "band": f.band,
        "launch_utc": _timestamptz(f.launch_utc) if f.launch_utc else None,
        "launch_lat": f.launch_lat,
        "launch_lon": f.launch_lon,
        "status": f.status,
        "close_reason": f.close_reason,
    } for f in flights]
    return _upsert("flights", "flight_id", rows)


def push_telemetry(records: list[dict]) -> bool:
    """Push local telemetry rows (the store.py shape). Local-only provenance
    columns stay local; the remote table wants speed in a `speed_kt` column
    and real booleans and timestamps."""
    rows = [remote_telemetry_row(r) for r in records]
    return _upsert("telemetry", "flight_id,utc", rows)


def remote_telemetry_row(record: dict) -> dict:
    return {
        "flight_id": record["flight_id"],
        "utc": _timestamptz(record["utc"]),
        "grid6": record["grid6"],
        "lat": record["lat"],
        "lon": record["lon"],
        "altitude_m": record["altitude_m"],
        "speed_kt": record["speed_knots"],
        "voltage_v": record["voltage_v"],
        "temperature_c": record["temperature_c"],
        "gps_valid": bool(record["gps_valid"]),
        "rx_station_count": record["rx_station_count"],
        "matcher_name": record["matcher_name"],
        "matcher_version": record["matcher_version"],
    }


def _timestamptz(utc: str) -> str:
    # Local rows store naive UTC ("2026-08-18 00:04:00"); make the zone
    # explicit so the remote column never depends on a server default.
    return utc.replace(" ", "T") + ("" if utc.endswith("Z") else "Z")


def _upsert(table: str, conflict_columns: str, rows: list[dict]) -> bool:
    try:
        url = os.environ["SUPABASE_URL"].rstrip("/")
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    except KeyError as exc:
        print(f"supabase push skipped, {exc.args[0]} not set (non-fatal)",
              file=sys.stderr)
        return False

    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }
    try:
        for i in range(0, len(rows), _CHUNK_ROWS):
            resp = requests.post(
                f"{url}/rest/v1/{table}",
                params={"on_conflict": conflict_columns},
                headers=headers,
                json=rows[i:i + _CHUNK_ROWS],
                timeout=_TIMEOUT_S)
            resp.raise_for_status()
    except requests.RequestException as exc:
        print(f"supabase push to {table} failed (non-fatal): {exc}",
              file=sys.stderr)
        return False
    return True
