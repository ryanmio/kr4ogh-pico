"""Query wspr.live for raw WSPR spot rows.

Returns raw rows only: no decoding, no filtering beyond the SQL. Query text is
built by separate functions so callers can record exactly what was asked in
the `pulls` table.

Endpoint and constraints from https://wspr.live/:
  - ClickHouse HTTP interface at https://db1.wspr.live/, GET with a ?query=
    parameter only (POST requests are not accepted)
  - database `wspr`, spot table `rx`
  - "every query you take should limit the data you request by time and band"
  - rate limit of 20 requests per minute

wspr.live is a free community service run by one person. Every query here is
bounded in time, filtered by band, and kept as narrow as the job allows.
"""

from datetime import datetime, timedelta

import requests

ENDPOINT = "https://db1.wspr.live/"

# Every column of wspr.rx, in table order (https://wspr.live/ "Database
# Fields"). Selected explicitly so a row means the same thing regardless of
# future schema additions upstream.
SPOT_COLUMNS = (
    "id", "time", "band", "rx_sign", "rx_lat", "rx_lon", "rx_loc",
    "tx_sign", "tx_lat", "tx_lon", "tx_loc", "distance", "azimuth",
    "rx_azimuth", "frequency", "power", "snr", "drift", "version", "code",
)

# Refuse windows that would sweep months of data in one request.
MAX_WINDOW = timedelta(days=31)


def _time_bounds(window_start: datetime, window_end: datetime) -> str:
    if window_end <= window_start:
        raise ValueError(f"empty window: {window_start} .. {window_end}")
    if window_end - window_start > MAX_WINDOW:
        raise ValueError(f"window longer than {MAX_WINDOW}: {window_start} .. {window_end}")
    start = window_start.strftime("%Y-%m-%d %H:%M:%S")
    end = window_end.strftime("%Y-%m-%d %H:%M:%S")
    return f"time >= '{start}' AND time < '{end}'"


def regular_spots_query(callsign: str, band: int,
                        window_start: datetime, window_end: datetime) -> str:
    """Regular Type 1 spots by transmitter callsign.

    `band` is the wspr.live band code (first digits of frequency: 14 for 20 m,
    see the bands table on https://wspr.live/).
    """
    cols = ", ".join(SPOT_COLUMNS)
    return (f"SELECT {cols} FROM wspr.rx "
            f"WHERE {_time_bounds(window_start, window_end)} "
            f"AND band = {int(band)} "
            f"AND tx_sign = '{callsign.strip().upper()}'")


def telemetry_candidates_query(id13: str, band: int, telemetry_minute: int,
                               window_start: datetime, window_end: datetime) -> str:
    """Telemetry candidate spots: 6-char callsigns carrying the given id13 in
    characters 1 and 3, in the channel's telemetry minute.

    No frequency filter: receiver calibration error is handled by the matcher,
    not by the SQL.
    """
    if len(id13) != 2 or id13[0] not in "01Q" or not id13[1].isdigit():
        raise ValueError(f"malformed id13: {id13!r}")
    if telemetry_minute not in (0, 2, 4, 6, 8):
        raise ValueError(f"telemetry minute must be even: {telemetry_minute!r}")
    cols = ", ".join(SPOT_COLUMNS)
    return (f"SELECT {cols} FROM wspr.rx "
            f"WHERE {_time_bounds(window_start, window_end)} "
            f"AND band = {int(band)} "
            f"AND substring(tx_sign, 1, 1) = '{id13[0]}' "
            f"AND substring(tx_sign, 3, 1) = '{id13[1]}' "
            f"AND length(tx_sign) = 6 "
            f"AND toMinute(time) % 10 = {int(telemetry_minute)}")


def fetch_spots(query: str, timeout_s: float = 60.0) -> list[dict]:
    """Run a query against wspr.live and return raw rows as dicts."""
    resp = requests.get(ENDPOINT, params={"query": query + " FORMAT JSON"},
                        timeout=timeout_s)
    resp.raise_for_status()
    return resp.json()["data"]
