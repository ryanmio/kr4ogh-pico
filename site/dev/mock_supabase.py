"""Credential-free preview of the site's live path.

Serves the two PostgREST endpoints the site reads — /rest/v1/flights and
/rest/v1/telemetry — from a local picolog SQLite file, speaking just enough
of the query dialect the site uses (flight_id=eq.X, order, limit, Range).
Point the site at it and the live pages work with no Supabase project at all:

    python3 dev/mock_supabase.py --db ../tool/demo.db --flights dev/demo_flights.toml
    PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 PUBLIC_SUPABASE_ANON_KEY=dev npm run dev

Dev tool only. Nothing on the real site depends on it, and it never writes.

The flights TOML mirrors the remote `flights` table. An entry may carry
`source_flight_id` to replay another flight's local telemetry under its own
id (the repo's demo day is archived under its real id, and the home page
hides archived ids from the live section — an alias lets the same data
preview the live path). `--shift-to-now` slides all timestamps so the newest
record is "just heard", making relative times realistic.
"""

import argparse
import json
import sqlite3
import tomllib
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

TELEMETRY_SQL = ("SELECT flight_id, utc, grid6, lat, lon, altitude_m,"
                 " speed_knots, voltage_v, temperature_c, gps_valid,"
                 " rx_station_count, matcher_name, matcher_version"
                 " FROM telemetry WHERE flight_id = ? ORDER BY utc {order}")


def load_flights(path: str) -> list[dict]:
    with open(path, "rb") as f:
        data = tomllib.load(f)
    flights = []
    for entry in data.get("flights", []):
        flights.append({
            "flight_id": entry["flight_id"],
            "callsign": entry["callsign"],
            "channel": entry["channel"],
            "band": entry["band"],
            "launch_utc": entry.get("launch_utc"),
            "launch_lat": entry.get("launch_lat"),
            "launch_lon": entry.get("launch_lon"),
            "status": entry.get("status", "live"),
            "close_reason": entry.get("close_reason"),
            "source_flight_id": entry.get("source_flight_id", entry["flight_id"]),
        })
    return flights


class Handler(BaseHTTPRequestHandler):
    db_path: str
    flights: list[dict]
    shift: timedelta

    def _send(self, body: list | dict, status: int = 200) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers",
                         "apikey, authorization, range, content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")

    def do_OPTIONS(self) -> None:  # noqa: N802 (http.server naming)
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/rest/v1/flights":
            rows = [{k: v for k, v in f.items() if k != "source_flight_id"}
                    for f in self.flights]
            self._send(rows)
        elif url.path == "/rest/v1/telemetry":
            self._send(self._telemetry(query))
        else:
            self._send({"message": f"no such route: {url.path}"}, status=404)

    def _telemetry(self, query: dict) -> list[dict]:
        flight_id = query.get("flight_id", "eq.").removeprefix("eq.")
        aliases = {f["flight_id"]: f["source_flight_id"] for f in self.flights}
        order = "DESC" if query.get("order", "").endswith(".desc") else "ASC"

        conn = sqlite3.connect(self.db_path)
        rows = conn.execute(TELEMETRY_SQL.format(order=order),
                            (aliases.get(flight_id, flight_id),)).fetchall()
        conn.close()

        offset, limit = 0, len(rows)
        if "limit" in query:
            limit = int(query["limit"])
        range_header = self.headers.get("Range")
        if range_header:
            lo, hi = range_header.split("-")
            offset, limit = int(lo), int(hi) - int(lo) + 1

        out = []
        for (fid, utc, grid6, lat, lon, altitude_m, speed_knots, voltage_v,
             temperature_c, gps_valid, rx_station_count, matcher_name,
             matcher_version) in rows[offset:offset + limit]:
            shifted = (datetime.fromisoformat(utc) + self.shift)
            out.append({
                "flight_id": flight_id,
                "utc": shifted.strftime("%Y-%m-%dT%H:%M:%S+00:00"),
                "grid6": grid6,
                "lat": lat,
                "lon": lon,
                "altitude_m": altitude_m,
                "speed_kt": speed_knots,
                "voltage_v": voltage_v,
                "temperature_c": temperature_c,
                "gps_valid": bool(gps_valid),
                "rx_station_count": rx_station_count,
                "matcher_name": matcher_name,
                "matcher_version": matcher_version,
            })
        return out

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.command} {self.path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="picolog SQLite file")
    parser.add_argument("--flights", required=True,
                        help="TOML flight list (see dev/demo_flights.toml)")
    parser.add_argument("--port", type=int, default=54321)
    parser.add_argument("--shift-to-now", action="store_true",
                        help="slide timestamps so the newest record is now")
    args = parser.parse_args()

    Handler.db_path = args.db
    Handler.flights = load_flights(args.flights)
    Handler.shift = timedelta(0)
    if args.shift_to_now:
        conn = sqlite3.connect(args.db)
        newest = conn.execute("SELECT max(utc) FROM telemetry").fetchone()[0]
        conn.close()
        now = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)
        Handler.shift = now - datetime.fromisoformat(newest)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"mock supabase on http://127.0.0.1:{args.port} "
          f"({len(Handler.flights)} flights, shift {Handler.shift})")
    server.serve_forever()


if __name__ == "__main__":
    main()
