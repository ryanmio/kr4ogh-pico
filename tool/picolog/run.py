"""Ingest run: pull, decode, push. One invocation, bounded window.

Used both by the operator locally (persistent SQLite, the flight record) and
by the scheduled GitHub Actions workflow (throwaway SQLite, only there to feed
the Supabase cache while the operator's laptop is asleep). Same code either
way — the operator's local run is authoritative.
"""

import argparse
from datetime import datetime, timedelta, timezone

from .config import load_flights
from .pipeline import pull_flight_window, rebuild_flight_telemetry
from .sink_supabase import push_flights, push_telemetry
from .store import Store, TELEMETRY_COLUMNS


def run(flights_path: str, db_path: str, window_hours: float) -> None:
    flights = [f for f in load_flights(flights_path) if f.active]
    if not flights:
        print("no active flights")
        return

    # wspr.live stores naive UTC timestamps; query with the same convention
    now = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)
    window_start = now - timedelta(hours=window_hours)

    with Store(db_path) as store:
        for flight in flights:
            new_spots = pull_flight_window(store, flight, window_start, now)
            records = rebuild_flight_telemetry(store, flight)
            print(f"{flight.flight_id}: {new_spots} new spots, "
                  f"{records} telemetry records")

        pushed = push_flights(flights)
        rows = [dict(zip(TELEMETRY_COLUMNS, r)) for r in store.conn.execute(
            f"SELECT {', '.join(TELEMETRY_COLUMNS)} FROM telemetry")]
        pushed = push_telemetry(rows) and pushed
        print(f"supabase push {'ok' if pushed else 'FAILED (record unaffected)'}: "
              f"{len(rows)} telemetry rows")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--flights", required=True, help="flights.toml path")
    parser.add_argument("--db", required=True, help="SQLite file path")
    parser.add_argument("--window-hours", type=float, default=1.0,
                        help="how far back to pull (default: 1)")
    args = parser.parse_args()
    run(args.flights, args.db, args.window_hours)


if __name__ == "__main__":
    main()
