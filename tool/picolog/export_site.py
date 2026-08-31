"""Export the site's static flight data from the local record.

The public site reads two things at build time:

  site/src/data/flights.json        the flights to show, in flight_id order
  site/src/data/tracks/<id>.json    each flight's decoded track, oldest first

Both are committed to git, and the site bundles them into the page so a
visitor sees the balloon on first paint with no network round trip. The page
then queries wspr.live directly for anything newer, so these files being
stale is a cosmetic issue, never a correctness one: a visitor always ends up
with the newest fixes either way.

MERGE, never truncate. The scheduled workflow ingests into a throwaway
database holding only the last hour, so writing a track straight from that
database would delete a long flight's history. Every export therefore reads
the committed track first and unions it with what the database holds, keyed
by UTC. That makes the export idempotent and safe to run from any window.

Which flights appear: any flight that is `active` (in the air now), plus any
flight explicitly marked `status = "closed"` (flown, finished, still worth
showing). A flight that is merely inactive -- switched off but not closed --
is deliberately absent, which is how a launch that failed stays off the site.
"""

import argparse
import json
import sqlite3
from pathlib import Path

from .config import Flight, load_flights

# The site's TrackPoint shape (site/src/lib/types.ts). `speed_knots` is
# `speed_kt` here, which is what the site has always called it.
_TRACK_FIELDS = (
    ("utc", "utc"),
    ("grid6", "grid6"),
    ("lat", "lat"),
    ("lon", "lon"),
    ("altitude_m", "altitude_m"),
    ("speed_kt", "speed_knots"),
    ("voltage_v", "voltage_v"),
    ("temperature_c", "temperature_c"),
    ("gps_valid", "gps_valid"),
    ("rx_station_count", "rx_station_count"),
)


def _shown(flight: Flight) -> bool:
    return flight.active or flight.status == "closed"


def _flight_row(flight: Flight) -> dict:
    return {
        "flight_id": flight.flight_id,
        "callsign": flight.callsign,
        "band": flight.band,
        "channel": flight.channel,
        "launch_utc": flight.launch_utc,
        "launch_lat": flight.launch_lat,
        "launch_lon": flight.launch_lon,
        "status": flight.status,
        "close_reason": flight.close_reason,
    }


def _track_from_db(conn: sqlite3.Connection, flight_id: str) -> list[dict]:
    cols = ", ".join(src for _, src in _TRACK_FIELDS)
    rows = conn.execute(
        f"SELECT {cols} FROM telemetry WHERE flight_id = ? ORDER BY utc",
        (flight_id,)).fetchall()
    out = []
    for row in rows:
        point = dict(zip((dst for dst, _ in _TRACK_FIELDS), row))
        point["gps_valid"] = bool(point["gps_valid"])
        out.append(point)
    return out


def _merge(existing: list[dict], incoming: list[dict]) -> list[dict]:
    """Union by UTC, newer decode winning a collision. Re-running the matcher
    after a fix should update a row, never duplicate or drop it."""
    by_utc = {p["utc"]: p for p in existing}
    by_utc.update({p["utc"]: p for p in incoming})
    return [by_utc[k] for k in sorted(by_utc)]


def _write_if_changed(path: Path, payload) -> bool:
    text = json.dumps(payload, separators=(",", ":"), sort_keys=False)
    if path.exists() and path.read_text() == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return True


def export(flights_path: str, db_path: str, site_dir: str) -> None:
    flights = [f for f in load_flights(flights_path) if _shown(f)]
    data_dir = Path(site_dir) / "src" / "data"
    tracks_dir = data_dir / "tracks"

    changed = _write_if_changed(data_dir / "flights.json",
                                [_flight_row(f) for f in flights])
    print(f"flights.json: {len(flights)} flights"
          f"{' (updated)' if changed else ' (unchanged)'}")

    with sqlite3.connect(db_path) as conn:
        for flight in flights:
            path = tracks_dir / f"{flight.flight_id}.json"
            existing = json.loads(path.read_text()) if path.exists() else []
            merged = _merge(existing, _track_from_db(conn, flight.flight_id))
            changed = _write_if_changed(path, merged)
            print(f"{flight.flight_id}: {len(merged)} points "
                  f"(+{len(merged) - len(existing)})"
                  f"{' updated' if changed else ' unchanged'}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--flights", required=True, help="flights.toml path")
    parser.add_argument("--db", required=True, help="SQLite file path")
    parser.add_argument("--site", default="site", help="path to the site directory")
    args = parser.parse_args()
    export(args.flights, args.db, args.site)


if __name__ == "__main__":
    main()
