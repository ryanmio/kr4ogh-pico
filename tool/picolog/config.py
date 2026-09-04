"""Site and flight configuration, read from flights.toml at the repo root.

The same file the site reads at build time (src/lib/config.ts), so the tool
and the site never disagree about what is flying. The checks here mirror
that file's, and each failure names the field and says what was expected:
the person editing flights.toml is the reader, and the first place a mistake
shows up is a failed build or a failed Actions run.

Callsign, channel, band and dates are configuration, never hardcoded.
"""

import re
import tomllib
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

# wspr.live band codes: first digits of frequency (bands table on
# https://wspr.live/).
BAND_CODES = {"20m": 14}

# Default location, relative to the repo root the tool is run from.
DEFAULT_PATH = "flights.toml"

_FLIGHT_ID = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
_CALLSIGN = re.compile(r"^[A-Z0-9/]{3,10}$")
_LAUNCH_UTC = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
_FLIGHT_FIELDS = {
    "flight_id", "callsign", "band", "channel", "active", "launch_utc",
    "launch_lat", "launch_lon", "status", "close_reason", "tracker",
}


class ConfigError(ValueError):
    """flights.toml is missing, malformed, or says something impossible."""


@dataclass(frozen=True)
class Site:
    callsign: str
    url: str | None = None
    repo: str | None = None


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
    # Build details for the site's Tracker panel, label -> value, in the
    # order written. The tool carries it through untouched.
    tracker: dict[str, str] | None = None

    @property
    def band_code(self) -> int:
        return BAND_CODES[self.band]

    @property
    def launch(self) -> datetime | None:
        """launch_utc as a naive UTC datetime, the convention wspr.live
        stores and this tool queries with."""
        if self.launch_utc is None:
            return None
        return datetime.strptime(self.launch_utc, "%Y-%m-%d %H:%M:%S")


def _read(path: str | Path) -> dict:
    path = Path(path)
    try:
        with open(path, "rb") as f:
            return tomllib.load(f)
    except FileNotFoundError:
        raise ConfigError(f"{path}: not found (expected at the repo root)") from None
    except tomllib.TOMLDecodeError as err:
        raise ConfigError(f"{path}: not valid TOML: {err}") from None


def _fail(where: str, msg: str) -> None:
    raise ConfigError(f"flights.toml: {where}: {msg}")


def _optional_str(entry: dict, where: str, key: str) -> str | None:
    value = entry.get(key)
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        _fail(f"{where}.{key}", "must be text in quotes")
    return value


def _optional_num(entry: dict, where: str, key: str) -> float | None:
    value = entry.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{where}.{key}", "must be a number")
    return float(value)


def _flight(entry: object, index: int) -> Flight:
    where = f"[[flights]] #{index + 1}"
    if not isinstance(entry, dict):
        _fail(where, "must be a table")
    for key in entry:
        if key not in _FLIGHT_FIELDS:
            _fail(f"{where}.{key}", "unknown field; see the comments at the top of the file")

    flight_id = entry.get("flight_id")
    if not isinstance(flight_id, str) or not _FLIGHT_ID.match(flight_id):
        _fail(f"{where}.flight_id",
              'required; letters, digits, "-" or "_" only, e.g. "F1" (it is used in the URL)')
    where = f"[[flights]] {flight_id}"

    callsign = entry.get("callsign")
    if not isinstance(callsign, str):
        _fail(f"{where}.callsign", 'required, e.g. "N0CALL"')
    callsign = callsign.strip().upper()
    if not _CALLSIGN.match(callsign):
        _fail(f"{where}.callsign", f'"{entry["callsign"]}" does not look like a callsign')

    band = entry.get("band")
    if band not in BAND_CODES:
        _fail(f"{where}.band",
              f'must be one of {sorted(BAND_CODES)} (only 20 m is supported so far)')

    channel = entry.get("channel")
    if isinstance(channel, bool) or not isinstance(channel, int) or not 0 <= channel <= 599:
        _fail(f"{where}.channel", "must be a whole number from 0 to 599 (the Traquito channel)")

    active = entry.get("active", True)
    if not isinstance(active, bool):
        _fail(f"{where}.active", "must be true or false")

    launch_utc = _optional_str(entry, where, "launch_utc")
    if launch_utc is not None:
        if not _LAUNCH_UTC.match(launch_utc):
            _fail(f"{where}.launch_utc", 'must look like "2026-08-30 12:44:00" (UTC, in quotes)')
        try:
            datetime.strptime(launch_utc, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            _fail(f"{where}.launch_utc", f'"{launch_utc}" is not a real date and time')

    status = entry.get("status", "live")
    if status not in ("live", "closed"):
        _fail(f"{where}.status", 'must be "live" or "closed"')

    tracker = entry.get("tracker")
    if tracker is not None:
        if not isinstance(tracker, dict):
            _fail(f"{where}.tracker", "must be a table of label = value lines")
        tracker = {str(k): str(v) for k, v in tracker.items()}

    return Flight(
        flight_id=flight_id,
        callsign=callsign,
        band=band,
        channel=channel,
        active=active,
        launch_utc=launch_utc,
        launch_lat=_optional_num(entry, where, "launch_lat"),
        launch_lon=_optional_num(entry, where, "launch_lon"),
        status=status,
        close_reason=_optional_str(entry, where, "close_reason"),
        tracker=tracker,
    )


def load_flights(path: str | Path = DEFAULT_PATH) -> list[Flight]:
    """Every [[flights]] entry, in file order, validated."""
    data = _read(path)
    entries = data.get("flights", [])
    if not isinstance(entries, list):
        _fail("flights", "must be written as [[flights]] tables")
    flights = [_flight(entry, i) for i, entry in enumerate(entries)]
    seen: set[str] = set()
    for f in flights:
        if f.flight_id in seen:
            _fail(f"[[flights]] {f.flight_id}", "flight_id used twice")
        seen.add(f.flight_id)
    return flights


def load_site(path: str | Path = DEFAULT_PATH) -> Site:
    """The [site] table."""
    data = _read(path)
    site = data.get("site")
    if not isinstance(site, dict):
        _fail("[site]", "required: a [site] table with at least a callsign")
    callsign = site.get("callsign")
    if not isinstance(callsign, str) or not _CALLSIGN.match(callsign.strip().upper()):
        _fail("[site].callsign", 'required, e.g. "N0CALL"')
    return Site(
        callsign=callsign.strip().upper(),
        url=_optional_str(site, "[site]", "url"),
        repo=_optional_str(site, "[site]", "repo"),
    )
