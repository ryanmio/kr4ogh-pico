"""Pull spots for a flight, and rebuild its decoded telemetry from raw spots.

Two halves, deliberately separate: `pull_flight_window` talks to wspr.live and
only appends raw rows; `rebuild_flight_telemetry` reads raw rows back from the
local store, matches, decodes, and overwrites derived records. The derived
side never touches the network and can be re-run at any time.
"""

from datetime import datetime

from .channels import channel_table_20m
from .config import Flight
from .decode import decode_callsign, decode_grid_power, maidenhead_to_latlon
from .match import NAME as MATCHER_NAME
from .match import VERSION as MATCHER_VERSION
from .match import Match, fingerprint_match
from .store import Store
from .wsprlive import fetch_spots, regular_spots_query, telemetry_candidates_query


def pull_flight_window(store: Store, flight: Flight,
                       window_start: datetime, window_end: datetime) -> int:
    """Fetch Regular spots and Telemetry candidates for one flight over a
    bounded window; append raw rows and record both pulls. Returns the number
    of newly stored spots."""
    channel = channel_table_20m()[flight.channel]
    new_rows = 0

    query = regular_spots_query(flight.callsign, flight.band_code,
                                window_start, window_end)
    rows = fetch_spots(query)
    new_rows += store.insert_spots(rows)
    store.record_pull(window_start, window_end, flight.band_code,
                      f"regular:{flight.flight_id}", query, len(rows))

    query = telemetry_candidates_query(channel.id13, flight.band_code,
                                       channel.telemetry_minute,
                                       window_start, window_end)
    rows = fetch_spots(query)
    new_rows += store.insert_spots(rows)
    store.record_pull(window_start, window_end, flight.band_code,
                      f"telemetry:{flight.flight_id}", query, len(rows))
    return new_rows


def rebuild_flight_telemetry(store: Store, flight: Flight) -> int:
    """Match and decode every stored spot for one flight, overwriting its
    derived records. Returns the number of records written."""
    channel = channel_table_20m()[flight.channel]

    # The Regular pull is by callsign only: the same callsign can fly several
    # channels at once, so restrict to this channel's start minute here.
    regulars = _spot_rows(store,
                          "tx_sign = ? AND band = ? AND "
                          "CAST(strftime('%M', time) AS INTEGER) % 10 = ?",
                          (flight.callsign, flight.band_code,
                           channel.start_minute))
    candidates = _spot_rows(store,
                            "substr(tx_sign, 1, 1) = ? AND substr(tx_sign, 3, 1) = ? "
                            "AND length(tx_sign) = 6 AND band = ? AND "
                            "CAST(strftime('%M', time) AS INTEGER) % 10 = ?",
                            (channel.id13[0], channel.id13[1],
                             flight.band_code, channel.telemetry_minute))

    records = []
    for m in fingerprint_match(regulars, candidates):
        record = _decode_match(flight, m)
        if record is not None:
            records.append(record)
    store.upsert_telemetry(records)
    return len(records)


def _decode_match(flight: Flight, m: Match) -> dict | None:
    """Turn a matched spot pair into a telemetry record, or None when the
    paired payload is not decodable Basic Telemetry (a false WSPR decode, or
    an extended-telemetry packet)."""
    try:
        callsign_part = decode_callsign(m.telemetry_spot["tx_sign"])
        grid_power_part = decode_grid_power(m.telemetry_spot["tx_loc"],
                                            int(m.telemetry_spot["power"]))
    except ValueError:
        return None
    if grid_power_part.hdr_type != 1:  # 1 = standard Basic Telemetry
        return None

    grid6 = (m.regular_spot["tx_loc"][:4].upper()
             + callsign_part.grid5.lower() + callsign_part.grid6.lower())
    lat, lon = maidenhead_to_latlon(grid6)
    return {
        "flight_id": flight.flight_id,
        "utc": m.slot_utc,
        "grid6": grid6,
        "lat": lat,
        "lon": lon,
        "altitude_m": callsign_part.altitude_m,
        "speed_knots": grid_power_part.speed_knots,
        "voltage_v": grid_power_part.voltage_v,
        "temperature_c": grid_power_part.temperature_c,
        "gps_valid": int(grid_power_part.gps_valid),
        "rx_station_count": m.rx_station_count,
        "regular_spot_id": int(m.regular_spot["id"]),
        "telemetry_spot_id": int(m.telemetry_spot["id"]),
        "matcher_name": MATCHER_NAME,
        "matcher_version": MATCHER_VERSION,
    }


def _spot_rows(store: Store, where: str, params: tuple) -> list[dict]:
    cur = store.conn.execute(f"SELECT * FROM spots WHERE {where}", params)
    columns = [d[0] for d in cur.description]
    return [dict(zip(columns, row)) for row in cur.fetchall()]
