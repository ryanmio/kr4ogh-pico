"""SQLite storage. This file is the authoritative flight record.

Three tables:

  pulls      one row per wspr.live query: what was asked, over what window,
             and how many rows came back
  spots      raw wspr.live rows, every column, unique on the wspr.live row id.
             Append-only: never updated, never deleted (enforced by triggers).
  telemetry  decoded records. Fully derivable from `spots`, safe to drop and
             rebuild — that is the point of storing raw.

`pulls` is load-bearing, not bookkeeping. It is what lets the tool distinguish
"no query ever covered this window" from "the balloon was silent". Those are
different facts, and the Fail and Wounded scoring definitions depend on
telling them apart. Any function that reports a reporting gap must consult
`pulls` (see `uncovered_windows`) and report uncovered windows separately from
silent ones.
"""

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS pulls (
    utc_run       TEXT NOT NULL,
    window_start  TEXT NOT NULL,
    window_end    TEXT NOT NULL,
    band          INTEGER NOT NULL,
    query_kind    TEXT NOT NULL,
    query_text    TEXT NOT NULL,
    row_count     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spots (
    id          INTEGER PRIMARY KEY,
    time        TEXT NOT NULL,
    band        INTEGER NOT NULL,
    rx_sign     TEXT NOT NULL,
    rx_lat      REAL,
    rx_lon      REAL,
    rx_loc      TEXT,
    tx_sign     TEXT NOT NULL,
    tx_lat      REAL,
    tx_lon      REAL,
    tx_loc      TEXT,
    distance    INTEGER,
    azimuth     INTEGER,
    rx_azimuth  INTEGER,
    frequency   INTEGER NOT NULL,
    power       INTEGER NOT NULL,
    snr         INTEGER,
    drift       INTEGER,
    version     TEXT,
    code        INTEGER
);

CREATE TRIGGER IF NOT EXISTS spots_no_update BEFORE UPDATE ON spots
BEGIN
    SELECT RAISE(ABORT, 'spots is append-only');
END;

CREATE TRIGGER IF NOT EXISTS spots_no_delete BEFORE DELETE ON spots
BEGIN
    SELECT RAISE(ABORT, 'spots is append-only');
END;

CREATE TABLE IF NOT EXISTS telemetry (
    flight_id          TEXT NOT NULL,
    utc                TEXT NOT NULL,
    grid6              TEXT NOT NULL,
    lat                REAL NOT NULL,
    lon                REAL NOT NULL,
    altitude_m         INTEGER NOT NULL,
    speed_knots        INTEGER NOT NULL,
    voltage_v          REAL NOT NULL,
    temperature_c      INTEGER NOT NULL,
    gps_valid          INTEGER NOT NULL,
    rx_station_count   INTEGER NOT NULL,
    regular_spot_id    INTEGER NOT NULL,
    telemetry_spot_id  INTEGER NOT NULL,
    matcher_name       TEXT NOT NULL,
    matcher_version    INTEGER NOT NULL,
    PRIMARY KEY (flight_id, utc)
);

CREATE INDEX IF NOT EXISTS spots_by_time ON spots (band, time);
"""

_SPOT_COLUMNS = ("id", "time", "band", "rx_sign", "rx_lat", "rx_lon", "rx_loc",
                 "tx_sign", "tx_lat", "tx_lon", "tx_loc", "distance", "azimuth",
                 "rx_azimuth", "frequency", "power", "snr", "drift", "version",
                 "code")

# ClickHouse's JSON format returns 64-bit integers as strings; coerce every
# numeric column so the local record is typed, whatever the wire gave us.
_SPOT_INT = {"id", "band", "distance", "azimuth", "rx_azimuth", "frequency",
             "power", "snr", "drift", "code"}
_SPOT_REAL = {"rx_lat", "rx_lon", "tx_lat", "tx_lon"}

TELEMETRY_COLUMNS = ("flight_id", "utc", "grid6", "lat", "lon", "altitude_m",
                     "speed_knots", "voltage_v", "temperature_c", "gps_valid",
                     "rx_station_count", "regular_spot_id", "telemetry_spot_id",
                     "matcher_name", "matcher_version")


def _fmt(t: datetime | str) -> str:
    if isinstance(t, datetime):
        return t.strftime("%Y-%m-%d %H:%M:%S")
    return t


class Store:
    def __init__(self, path: str | Path):
        self.conn = sqlite3.connect(path)
        self.conn.executescript(_SCHEMA)

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def record_pull(self, window_start: datetime, window_end: datetime,
                    band: int, query_kind: str, query_text: str,
                    row_count: int, utc_run: datetime | None = None) -> None:
        run = utc_run or datetime.now(timezone.utc)
        self.conn.execute(
            "INSERT INTO pulls (utc_run, window_start, window_end, band,"
            " query_kind, query_text, row_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (_fmt(run), _fmt(window_start), _fmt(window_end), band,
             query_kind, query_text, row_count))
        self.conn.commit()

    def insert_spots(self, rows: list[dict]) -> int:
        """Insert raw wspr.live rows; duplicates (same wspr.live id) are
        ignored. Returns the number of newly inserted rows."""
        placeholders = ", ".join("?" for _ in _SPOT_COLUMNS)
        sql = (f"INSERT OR IGNORE INTO spots ({', '.join(_SPOT_COLUMNS)}) "
               f"VALUES ({placeholders})")
        before = self.conn.total_changes
        for row in rows:
            values = []
            for col in _SPOT_COLUMNS:
                v = row[col]
                if v is not None and col in _SPOT_INT:
                    v = int(v)
                elif v is not None and col in _SPOT_REAL:
                    v = float(v)
                values.append(v)
            self.conn.execute(sql, values)
        self.conn.commit()
        return self.conn.total_changes - before

    def upsert_telemetry(self, records: list[dict]) -> None:
        """Insert or overwrite decoded records, keyed on (flight_id, utc).

        `telemetry` is derived data. Re-running after a matcher change
        overwrites rows with the newer matcher_name/matcher_version.
        """
        placeholders = ", ".join("?" for _ in TELEMETRY_COLUMNS)
        sql = (f"INSERT OR REPLACE INTO telemetry "
               f"({', '.join(TELEMETRY_COLUMNS)}) VALUES ({placeholders})")
        for rec in records:
            self.conn.execute(sql, [rec[c] for c in TELEMETRY_COLUMNS])
        self.conn.commit()

    def clear_telemetry(self) -> None:
        """Drop all derived records (before a rebuild from raw spots)."""
        self.conn.execute("DELETE FROM telemetry")
        self.conn.commit()

    def uncovered_windows(self, band: int, query_kind: str,
                          window_start: datetime,
                          window_end: datetime) -> list[tuple[str, str]]:
        """Sub-windows of [window_start, window_end) that no recorded pull of
        this kind has ever covered.

        An empty result means the whole window was queried, so an absence of
        spots there is genuine silence. A non-empty result means those
        stretches are unknown, not silent, and must be reported as such.
        """
        rows = self.conn.execute(
            "SELECT window_start, window_end FROM pulls"
            " WHERE band = ? AND query_kind = ?"
            " AND window_end > ? AND window_start < ?"
            " ORDER BY window_start",
            (band, query_kind, _fmt(window_start), _fmt(window_end))).fetchall()
        gaps = []
        cursor = _fmt(window_start)
        end = _fmt(window_end)
        for start, stop in rows:
            if start > cursor:
                gaps.append((cursor, min(start, end)))
            cursor = max(cursor, stop)
            if cursor >= end:
                break
        if cursor < end:
            gaps.append((cursor, end))
        return gaps
