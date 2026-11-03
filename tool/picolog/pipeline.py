"""Pull spots for a flight, and rebuild its decoded telemetry from raw spots.

Two halves, deliberately separate: `pull_flight_window` talks to wspr.live and
only appends raw rows; `rebuild_flight_telemetry` reads raw rows back from the
local store, matches, decodes, and overwrites derived records. The derived
side never touches the network and can be re-run at any time.
"""

from datetime import datetime, timedelta

from .channels import channel_table_20m
from .config import Flight
from .decode import (
    BME280_SLOT, decode_bme280_slot3, decode_callsign, decode_grid_power,
    maidenhead_to_latlon,
)
from .match import NAME as MATCHER_NAME
from .match import VERSION as MATCHER_VERSION
from .match import Match, RegularOnly, fingerprint_match, regular_only_slots
from . import infer as inferred_tier
from .store import Store
from .wsprlive import fetch_spots, regular_spots_query, telemetry_candidates_query


def pull_flight_window(store: Store, flight: Flight,
                       window_start: datetime, window_end: datetime) -> int:
    """Fetch Regular spots and Telemetry candidates for one flight over a
    bounded window, and the slot-3 candidates too when the tracker carries a
    sensor; append raw rows and record each pull. Returns the number of newly
    stored spots."""
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

    if flight.sensor == "bme280":
        query = telemetry_candidates_query(channel.id13, flight.band_code,
                                           channel.slot_minute(BME280_SLOT),
                                           window_start, window_end)
        rows = fetch_spots(query)
        new_rows += store.insert_spots(rows)
        store.record_pull(window_start, window_end, flight.band_code,
                          f"sensor:{flight.flight_id}", query, len(rows))
    return new_rows


def rebuild_flight_telemetry(store: Store, flight: Flight,
                             context: list[dict] | None = None) -> int:
    """Match and decode every stored spot for one flight, overwriting its
    derived records: the telemetry table, and beside it the ghosts, the
    slots heard without telemetry, and the inferred tier's decisions.
    Returns the number of telemetry records written.

    Two tiers (docs/cross-receiver-pairing.md). "confirmed" is the
    same-station fingerprint, unchanged. "inferred" is infer.py, tried only
    on the cycles the confirmed tier left empty.

    `context` is fixes from before what the store holds, oldest first, in
    the committed track's shape (picolog.export_site). The inferred tier
    measures each candidate against the last fix before it, and the
    scheduled run's throwaway store holds only the last day: without the
    committed track it would have nothing to measure the first one from.
    """
    channel =channel_table_20m()[flight.channel]

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

    # The sensor message, six minutes after the Regular, paired the same
    # way. It rides on the fix: a slot whose Basic Telemetry was not heard
    # has no position for the reading to belong to, so a sensor-only slot
    # is dropped, and a fix whose sensor message was not heard carries
    # nulls. A reading of -70 / 0 / 0 is the sensor not answering, which
    # is a fact about the sensor, not a measurement: dropped the same way.
    sensor_by_slot: dict[str, dict] = {}
    sensor_candidates: list[dict] = []
    if flight.sensor == "bme280":
        sen_where, sen_params = _span_clause(flight, timedelta(minutes=2 * BME280_SLOT))
        sensor_candidates = _spot_rows(
            store,
            "substr(tx_sign, 1, 1) = ? AND substr(tx_sign, 3, 1) = ? "
            "AND length(tx_sign) = 6 AND band = ? AND "
            "CAST(strftime('%M', time) AS INTEGER) % 10 = ?" + sen_where,
            (channel.id13[0], channel.id13[1], flight.band_code,
             channel.slot_minute(BME280_SLOT), *sen_params))
        for m in fingerprint_match(regulars, sensor_candidates,
                                   offset_minutes=2 * BME280_SLOT):
            reading = _decode_sensor_match(m)
            if reading is not None:
                sensor_by_slot[m.slot_utc] = {**reading, "sensor_tier": "confirmed",
                                              "sensor_pairing": None}

    records = []
    decoded = []
    for m in fingerprint_match(regulars, candidates):
        record = _decode_match(flight, m)
        if record is not None:
            records.append(record)
            decoded.append(m)

    # The inferred tier, on what the confirmed tier left. It measures
    # against every fix known before each candidate: the committed ones
    # from before anything this store holds, then this rebuild's.
    held = [s["time"] for s in regulars + candidates + sensor_candidates]
    first = min(held) if held else None
    known = [_context_fix(p) for p in (context or [])
             if first is None or _utc(p["utc"]) < first]
    # With their confirmed sensor readings: the spoof rule that picks the
    # fix to measure from reads the pressure.
    known = sorted(known + [{**r, "tier": "confirmed",
                             "pressure_hpa": sensor_by_slot.get(r["utc"], {}).get("pressure_hpa")}
                            for r in records],
                   key=lambda f: f["utc"])
    inf = inferred_tier.infer(
        channel, flight.flight_id, regulars, candidates, sensor_candidates, known,
        confirmed_basic={r["utc"] for r in records},
        confirmed_sensor=set(sensor_by_slot))
    records = sorted(records + inf.fixes, key=lambda r: r["utc"])
    sensors = {**sensor_by_slot, **inf.sensors}
    for record in records:
        record.update({k: v for k, v in sensors.get(record["utc"], _NO_SENSOR).items()
                       if k in _NO_SENSOR})
    store.upsert_telemetry(records)

    # A slot is a ghost when nothing paired in it, or when the pair was not
    # Basic Telemetry: the tracker was heard either way, and the grid square
    # is all that is known. A cycle the inferred tier filled is not one.
    # Mirrors src/lib/wspr/track.ts's decodeWindow.
    fixed = {r["utc"] for r in records}
    ghosts = [_ghost_record(flight, g) for g in regular_only_slots(regulars, decoded)
              if g.slot_utc not in fixed]
    # A sensor reading in a cycle with no fix rides on the cycle's ghost
    # instead, and where no Regular was heard in the cycle either, it
    # makes one, in the square the inferred tier placed it in.
    by_utc = {g["utc"]: g for g in ghosts}
    for cycle, reading in sensors.items():
        if cycle in fixed:
            continue
        ghost = by_utc.get(cycle)
        if ghost is None:
            if "grid4" not in reading:
                continue  # a confirmed reading whose cycle's square was tied
            lat, lon = maidenhead_to_latlon(reading["grid4"])
            ghost = {"flight_id": flight.flight_id, "utc": cycle,
                     "grid4": reading["grid4"], "lat": lat, "lon": lon,
                     "rx_station_count": reading["rx_station_count"],
                     "matcher_name": inferred_tier.NAME,
                     "matcher_version": inferred_tier.VERSION,
                     "grid_source": "neighbours"}
            ghosts.append(ghost)
            by_utc[cycle] = ghost
        ghost.update({k: v for k, v in reading.items() if k in _NO_SENSOR})
    store.replace_ghosts(flight.flight_id, sorted(ghosts, key=lambda g: g["utc"]))
    store.replace_pairings(flight.flight_id, [
        {"flight_id": flight.flight_id, "cycle_utc": d.cycle_utc, "kind": d.kind,
         "outcome": d.outcome, "reason": d.reason,
         "spot_ids": ",".join(str(i) for i in d.spot_ids)}
        for d in inf.decisions])
    return len(records)


def _utc(text: str) -> str:
    """A committed track's UTC in the store's form."""
    return text[:19].replace("T", " ")


def _context_fix(p: dict) -> dict:
    """A committed track point as the inferred tier reads a fix."""
    return {"utc": _utc(p["utc"]), "lat": p["lat"], "lon": p["lon"],
            "altitude_m": p["altitude_m"], "pressure_hpa": p.get("pressure_hpa"),
            "tier": p.get("tier", "confirmed")}


_NO_SENSOR = {"pressure_hpa": None, "board_temp_c": None, "humidity_pct": None,
              "sensor_spot_id": None, "sensor_tier": None, "sensor_pairing": None}


def _decode_sensor_match(m: Match) -> dict | None:
    """The sensor fields of a telemetry record from a matched slot-3 pair,
    or None when the payload is not the Petrel BME280 message or the sensor
    did not answer."""
    spot = m.telemetry_spot
    try:
        reading = decode_bme280_slot3(spot["tx_sign"], spot["tx_loc"], int(spot["power"]))
    except ValueError:
        return None
    if reading.sensor_failed:
        return None
    return {
        "pressure_hpa": reading.pressure_hpa,
        "board_temp_c": reading.temperature_c,
        "humidity_pct": reading.humidity_pct,
        "sensor_spot_id": int(spot["id"]),
    }


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
        "tier": "confirmed",
        "pairing": None,
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
