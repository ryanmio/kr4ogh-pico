"""Ingest run: pull and decode. One invocation, bounded window.

Used both by the operator locally (persistent SQLite, the flight record) and
by the scheduled GitHub Actions workflow (throwaway SQLite, feeding
picolog.export_site so the committed track stays current). Same code either
way — the operator's local run is authoritative.

Two ways to bound the window. `--window-hours` looks back a fixed span from
now: the routine run. `--from-launch` looks back to each flight's
launch_utc: the seeding run, for a site whose committed track is empty (a
fresh fork) or a record being rebuilt, which needs the whole flight.
wspr.live asks for bounded queries and allows 20 a minute, so a long window
is walked in chunks with a pause between them; a year-long flight is a few
minutes' work, once.

There is no push step and no sink: the public site reads the track committed
to git and queries wspr.live directly from the browser for anything newer, so
nothing downstream needs credentials. See docs/architecture.md.
"""

import argparse
import time
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

from .config import DEFAULT_PATH, load_flights
from .pipeline import pull_flight_window, rebuild_flight_telemetry
from .store import Store

# A week of one channel's telemetry candidates is a few MB; wspr.live's own
# ceiling is 31 days (wsprlive.MAX_WINDOW). Two queries per chunk, and a
# pause that keeps a long walk under the rate limit.
CHUNK = timedelta(days=7)
PAUSE_S = 4.0


def chunks(start: datetime, end: datetime,
           size: timedelta = CHUNK) -> Iterator[tuple[datetime, datetime]]:
    """Consecutive [a, b) windows of at most `size` covering [start, end)."""
    a = start
    while a < end:
        b = min(a + size, end)
        yield a, b
        a = b


def run(flights_path: str, db_path: str, window_hours: float,
        from_launch: bool = False) -> None:
    flights = [f for f in load_flights(flights_path) if f.active]
    if not flights:
        print("no active flights")
        return

    # wspr.live stores naive UTC timestamps; query with the same convention
    now = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)

    with Store(db_path) as store:
        for flight in flights:
            start = now - timedelta(hours=window_hours)
            if from_launch:
                if flight.launch is None:
                    print(f"{flight.flight_id}: no launch_utc, "
                          f"looking back {window_hours:g} h instead")
                else:
                    start = min(start, flight.launch)
            windows = list(chunks(start, now))
            new_spots = 0
            for i, (a, b) in enumerate(windows):
                if i:
                    time.sleep(PAUSE_S)
                new_spots += pull_flight_window(store, flight, a, b)
                if len(windows) > 1:
                    print(f"{flight.flight_id}: {a:%Y-%m-%d} .. {b:%Y-%m-%d} "
                          f"({i + 1}/{len(windows)})")
            records = rebuild_flight_telemetry(store, flight)
            print(f"{flight.flight_id}: {new_spots} new spots, "
                  f"{records} telemetry records")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--flights", default=DEFAULT_PATH, help="flights.toml path")
    parser.add_argument("--db", required=True, help="SQLite file path")
    parser.add_argument("--window-hours", type=float, default=1.0,
                        help="how far back to pull (default: 1)")
    parser.add_argument("--from-launch", action="store_true",
                        help="pull back to each flight's launch_utc, "
                             "in chunks, when that is further than the window")
    args = parser.parse_args()
    run(args.flights, args.db, args.window_hours, args.from_launch)


if __name__ == "__main__":
    main()
