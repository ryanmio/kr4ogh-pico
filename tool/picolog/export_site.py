"""Export the site's static flight data from the local record.

The public site reads its flight list from flights.toml and each flight's
decoded track from

  src/data/tracks/<callsign>-<flight_id>.json         oldest fix first
  src/data/tracks/<callsign>-<flight_id>.ghosts.json  the slots heard
                                                      without telemetry

The callsign is in the name because a copy of this repository made for
another callsign keeps whatever tracks were committed here; a flight of
theirs named like one of ours must not be merged into it. Tracks of flights
no longer shown are removed for the same reason, and because the site would
otherwise carry them forever: the record is the operator's SQLite file, and
an export can always be run again.

The tracks are committed to git, and the site bundles them into the page so
a visitor sees the balloon on first paint with no network round trip. The
page then queries wspr.live directly for anything newer, so a track being
stale is a cosmetic issue, never a correctness one: a visitor always ends up
with the newest fixes either way.

MERGE, never truncate. The scheduled workflow ingests into a throwaway
database holding only the last hour, so writing a track straight from that
database would delete a long flight's history. Every export therefore reads
the committed track first and unions it with what the database holds, keyed
by UTC. That makes the export idempotent and safe to run from any window.

The ghosts file is merged the same way and then pruned against the merged
track: a slot that was a ghost in one export and a full fix in the next is a
full fix, and nothing else.

Which flights appear: any flight that is `active` (in the air now), plus any
flight explicitly marked `status = "closed"` (flown, finished, still worth
showing). A flight that is merely inactive -- switched off but not closed --
is deliberately absent, which is how a launch that failed stays off the site.
"""

import argparse
import json
import sqlite3
from pathlib import Path

from .config import DEFAULT_PATH, Flight, load_flights

# The site's TrackPoint shape (src/lib/types.ts). `speed_knots` is
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


# The site's GhostPoint shape (src/lib/types.ts).
_GHOST_FIELDS = ("utc", "grid4", "lat", "lon", "rx_station_count")


def _shown(flight: Flight) -> bool:
    return flight.active or flight.status == "closed"


def track_filename(flight: Flight) -> str:
    """Mirrors src/lib/flights.ts."""
    return f"{flight.callsign}-{flight.flight_id}.json"


def ghosts_filename(flight: Flight) -> str:
    """Mirrors src/lib/flights.ts."""
    return f"{flight.callsign}-{flight.flight_id}.ghosts.json"



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


def _ghosts_from_db(conn: sqlite3.Connection, flight_id: str) -> list[dict]:
    rows = conn.execute(
        f"SELECT {', '.join(_GHOST_FIELDS)} FROM ghosts WHERE flight_id = ? "
        "ORDER BY utc", (flight_id,)).fetchall()
    return [dict(zip(_GHOST_FIELDS, row)) for row in rows]


def _prune_ghosts(track: list[dict], ghosts: list[dict]) -> list[dict]:
    """Drop every ghost whose slot has a full fix."""
    fixed = {p["utc"] for p in track}
    return [g for g in ghosts if g["utc"] not in fixed]


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
    tracks_dir = Path(site_dir) / "src" / "data" / "tracks"

    keep = {track_filename(f) for f in flights} | {ghosts_filename(f) for f in flights}
    for stale in sorted(tracks_dir.glob("*.json")) if tracks_dir.is_dir() else []:
        if stale.name not in keep:
            stale.unlink()
            print(f"{stale.name}: removed, no such flight is shown")

    with sqlite3.connect(db_path) as conn:
        for flight in flights:
            path = tracks_dir / track_filename(flight)
            existing = json.loads(path.read_text()) if path.exists() else []
            merged = _merge(existing, _track_from_db(conn, flight.flight_id))
            changed = _write_if_changed(path, merged)
            print(f"{flight.flight_id}: {len(merged)} points "
                  f"(+{len(merged) - len(existing)})"
                  f"{' updated' if changed else ' unchanged'}")

            gpath = tracks_dir / ghosts_filename(flight)
            existing = json.loads(gpath.read_text()) if gpath.exists() else []
            ghosts = _prune_ghosts(
                merged, _merge(existing, _ghosts_from_db(conn, flight.flight_id)))
            changed = _write_if_changed(gpath, ghosts)
            print(f"{flight.flight_id}: {len(ghosts)} heard without telemetry "
                  f"({len(ghosts) - len(existing):+d})"
                  f"{' updated' if changed else ' unchanged'}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--flights", default=DEFAULT_PATH, help="flights.toml path")
    parser.add_argument("--db", required=True, help="SQLite file path")
    parser.add_argument("--site", default=".", help="path to the site (repo root)")
    args = parser.parse_args()
    export(args.flights, args.db, args.site)


if __name__ == "__main__":
    main()
