"""Ingest run: pull and decode. One invocation, bounded window.

Used both by the operator locally (persistent SQLite, the flight record) and
by the scheduled GitHub Actions workflow (throwaway SQLite, feeding
picolog.export_site so the committed track stays current). Same code either
way — the operator's local run is authoritative.

There is no push step and no sink: the public site reads the track committed
to git and queries wspr.live directly from the browser for anything newer, so
nothing downstream needs credentials. See docs/architecture.md.
"""

import argparse
from datetime import datetime, timedelta, timezone

from .config import DEFAULT_PATH, load_flights
from .pipeline import pull_flight_window, rebuild_flight_telemetry
from .store import Store


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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--flights", default=DEFAULT_PATH, help="flights.toml path")
    parser.add_argument("--db", required=True, help="SQLite file path")
    parser.add_argument("--window-hours", type=float, default=1.0,
                        help="how far back to pull (default: 1)")
    args = parser.parse_args()
    run(args.flights, args.db, args.window_hours)


if __name__ == "__main__":
    main()
