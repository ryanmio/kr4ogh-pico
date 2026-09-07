"""Pull spots for a flight, and rebuild its decoded telemetry from raw spots.

Two halves, deliberately separate: `pull_flight_window` talks to wspr.live and
only appends raw rows; `rebuild_flight_telemetry` reads raw rows back from the
local store, matches, decodes, and overwrites derived records. The derived
side never touches the network and can be re-run at any time.
"""

from datetime import datetime, timedelta

from .channels import channel_table_20m
from .config import Flight
from .decode import decode_callsign, decode_grid_power, maidenhead_to_latlon
from .match import NAME as MATCHER_NAME
from .match import VERSION as MATCHER_VERSION
from .match import Match, RegularOnly, fingerprint_match, regular_only_slots
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
    derived records: the telemetry table, and beside it the ghosts, the
    slots heard without telemetry. Returns the number of telemetry records
    written."""
    channel = channel_table_20m()[flight.channel]

    # Only spots from the flight's own span, launch_utc to end_utc: the store
    # holds every flight's spots, and two flights on one channel with one
    # callsign are told apart by when they flew and nothing else. The
    # Telemetry message follows the Regular by two minutes, so its bound
    # sits two minutes later, or the last fix before the end would lose
    # its second half.
    reg_where, reg_params = _span_clause(flight, timedelta(0))
    tel_where, tel_params = _span_clause(flight, timedelta(minutes=2))

    # The Regular pull is by callsign only: the same callsign can fly several
    # channels at once, so restrict to this channel's start minute here.
    regulars = _spot_rows(store,
                          "tx_sign = ? AND band = ? AND "
                          "CAST(strftime('%M', time) AS INTEGER) % 10 = ?" + reg_where,
                          (flight.callsign, flight.band_code,
                           channel.start_minute, *reg_params))
    candidates = _spot_rows(store,
                            "substr(tx_sign, 1, 1) = ? AND substr(tx_sign, 3, 1) = ? "
                            "AND length(tx_sign) = 6 AND band = ? AND "
                            "CAST(strftime('%M', time) AS INTEGER) % 10 = ?" + tel_where,
                            (channel.id13[0], channel.id13[1],
                             flight.band_code, channel.telemetry_minute, *tel_params))

    records = []
    decoded = []
    for m in fingerprint_match(regulars, candidates):
        record = _decode_match(flight, m)
        if record is not None:
            records.append(record)
            decoded.append(m)
    store.upsert_telemetry(records)
    # A slot is a ghost when nothing paired in it, or when the pair was not
    # Basic Telemetry: the tracker was heard either way, and the grid square
    # is all that is known. Mirrors src/lib/wspr/track.py's decodeWindow.
    store.replace_ghosts(flight.flight_id, [
        _ghost_record(flight, g)
        for g in regular_only_slots(regulars, decoded)])
    return len(records)


def _ghost_record(flight: Flight, g: RegularOnly) -> dict:
    lat, lon = maidenhead_to_latlon(g.grid4)
    return {
        "flight_id": flight.flight_id,
        "utc": g.slot_utc,
        "grid4": g.grid4,
        "lat": lat,
        "lon": lon,
        "rx_station_count": g.rx_station_count,
        "matcher_name": MATCHER_NAME,
        "matcher_version": MATCHER_VERSION,
    }


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


def _span_clause(flight: Flight, shift: timedelta) -> tuple[str, tuple]:
    """SQL restricting `time` to the flight's span, both ends moved by
    `shift`; empty when the flight is open at both ends."""
    where, params = "", []
    if flight.launch is not None:
        where += " AND time >= ?"
        params.append((flight.launch + shift).strftime("%Y-%m-%d %H:%M:%S"))
    if flight.end is not None:
        where += " AND time < ?"
        params.append((flight.end + shift).strftime("%Y-%m-%d %H:%M:%S"))
    return where, tuple(params)


def _spot_rows(store: Store, where: str, params: tuple) -> list[dict]:
    cur = store.conn.execute(f"SELECT * FROM spots WHERE {where}", params)
    columns = [d[0] for d in cur.description]
    return [dict(zip(columns, row)) for row in cur.fetchall()]
