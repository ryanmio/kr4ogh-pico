"""Flight configuration, read from a TOML file.

Callsign, channel, band, and dates are configuration, never hardcoded. A
committed config must not pre-announce a launch: launch_utc, launch_lat, and
launch_lon are filled in after the fact (see repo hard guards).
"""

import tomllib
from dataclasses import dataclass
from pathlib import Path

# wspr.live band codes: first digits of frequency (bands table on
# https://wspr.live/).
BAND_CODES = {"20m": 14}


@dataclass(frozen=True)
class Flight:
    flight_id: str
    callsign: str
    band: str
    channel: int
    active: bool = True
    launch_utc: str | None = None
    launch_lat: float | None = None
    launch_lon: float | None = None
    status: str = "live"
    close_reason: str | None = None

    @property
    def band_code(self) -> int:
        return BAND_CODES[self.band]


def load_flights(path: str | Path) -> list[Flight]:
    with open(path, "rb") as f:
        data = tomllib.load(f)
    flights = [Flight(**entry) for entry in data.get("flights", [])]
    ids = [f.flight_id for f in flights]
    if len(set(ids)) != len(ids):
        raise ValueError(f"duplicate flight_id in {path}")
    return flights
