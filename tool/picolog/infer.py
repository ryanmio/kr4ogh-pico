"""The second pairing tier: telemetry heard by a different station.

`match.py` pairs a telemetry message with our Regular message only when
the SAME station heard both. That tier is "confirmed", and nothing here
changes it. Over sparse-receiver country (Tibet, 3 Nov 2026) one station
hears the Regular messages and another hears the telemetry, and the
confirmed tier links nothing: every cycle is a ghost.

This module adds the "inferred" tier for the basic-telemetry and sensor
messages the confirmed tier left unpaired. The `1?0???` callsign proves
nothing on its own, because many balloons share it on this frequency, so a
message is accepted only when all of these hold:

  1. Slot and lane. It was sent in the right minute (the channel's slot 1
     for basic telemetry, slot 3 for the sensor), and at least one station
     reported it inside the channel's lane: `LANE_BELOW_HZ` under to
     `LANE_ABOVE_HZ` over the channel frequency.
  2. It decodes as ours. Basic telemetry with the GPS-valid bit set, or
     the Petrel sensor message (extended header 0/0/0, slot 3) with the
     sensor answering.
  3. There is a grid square to attach it to. Our Regular message in the
     same cycle, from any station, wins. With none heard in the cycle, the
     nearest heard Regular before and after it are used, but only when
     both are within `NEIGHBOUR_WINDOW` and both report the same square.
  4. It is physically plausible. Reachable from the last believed fix at
     `SPEED_FACTOR` times the larger of its reported speed and
     `SPEED_FLOOR_KT`, with slack for where a position sits inside its
     grid square. Its altitude is within `MAX_FLOAT_DEPARTURE_M` of the
     last believed CONFIRMED fix, so an inferred point never redefines
     float. And it is reachable from and to the Regular squares heard
     either side of it, so a position that teleports away and snaps back
     is refused.
  5. It is unambiguous. When more than one distinct message in the slot
     passes 1-4, none is accepted and the cycle is marked ambiguous.

Every decision is recorded with its reason, accepted or not, so the
outcome can be audited. Like everything derived, it is rebuilt from the
raw spots every time and never touches them.

"Believed" here is the site's GPS-spoof rule (src/lib/spoof.ts), mirrored
so the two agree: a fix is set aside when its pressure altitude and GPS
altitude are more than 3 km apart, or when it could not have been reached
from the last believed fix at 300 kt. A spoofed confirmed fix stays
confirmed, exactly as before. It is simply not used to judge an inferred
one.

Ported to src/lib/wspr/infer.ts; dev/verify-port.ts holds the two to the
same output.
"""

import math
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from .channels import Channel
from .decode import (
    BME280_SLOT, decode_bme280_slot3, decode_callsign, decode_grid_power,
    maidenhead_to_latlon,
)

NAME = "cross-receiver"
VERSION = 1

# The lane. Receivers report channel 206's 14,097,060 Hz anywhere from
# about 14,097,055 to 14,097,090 depending on their calibration; 5 Hz of
# margin either side gives this. It stays short of the halfway points to
# the neighbouring channels with the same id13 and minute (14,097,040 and
# 14,097,100).
LANE_BELOW_HZ = 10
LANE_ABOVE_HZ = 35

# How far either side of a cycle a Regular message may be and still lend
# its square, when the cycle's own Regular was not heard.
NEIGHBOUR_WINDOW = timedelta(minutes=30)

# Plausibility. A pico balloon in the jet stream rarely exceeds 150 kt.
SPEED_FACTOR = 1.5
SPEED_FLOOR_KT = 100
MAX_FLOAT_DEPARTURE_M = 1500

# Where a position can sit inside its square, at both ends of a leg: a
# grid6 subsquare is under 10 km across, a grid4 square about 110 by 220
# km. The same values as src/lib/spoof.ts.
GRID6_SLACK_KM = 15
GRID4_SLACK_KM = 140

# The site's spoof rule (src/lib/spoof.ts).
SPOOF_ALTITUDE_GAP_M = 3000
SPOOF_MAX_SPEED_KT = 300

KM_PER_NM = 1.852
_EARTH_RADIUS_KM = 6371
_FMT = "%Y-%m-%d %H:%M:%S"


@dataclass
class Decision:
    """What became of one cycle's unpaired messages of one kind."""
    cycle_utc: str
    kind: str  # "basic" or "sensor"
    outcome: str  # "inferred", "ambiguous", "rejected" or "unplaced"
    reason: str
    spot_ids: list[int] = field(default_factory=list)


@dataclass
class Inferred:
    fixes: list[dict]  # telemetry records, tier "inferred"
    sensors: dict[str, dict]  # cycle utc -> sensor fields, tier "inferred"
    decisions: list[Decision]


def _t(s: str) -> datetime:
    return datetime.strptime(s[:19].replace("T", " "), _FMT)


def _s(t: datetime) -> str:
    return t.strftime(_FMT)


def cycle_of(time: str, start_minute: int) -> str:
    """The Regular slot a message's cycle starts at."""
    t = _t(time)
    back = (t.minute - start_minute) % 10
    return _s(t - timedelta(minutes=back))


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Mirrors src/lib/format.ts."""
    rad = math.pi / 180
    d_lat = (lat2 - lat1) * rad
    d_lon = (lon2 - lon1) * rad
    a = (math.sin(d_lat / 2) ** 2
         + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.sin(d_lon / 2) ** 2)
    return 2 * _EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def pressure_altitude_m(hpa: float) -> float:
    """Mirrors src/lib/spoof.ts."""
    return 44330.8 * (1 - (hpa / 1013.25) ** 0.190263)


def in_lane(frequency: int, channel: Channel) -> bool:
    return (channel.frequency_hz - LANE_BELOW_HZ <= int(frequency)
            <= channel.frequency_hz + LANE_ABOVE_HZ)


def _hours(a: str, b: str) -> float:
    return abs((_t(a) - _t(b)).total_seconds()) / 3600


def _reach_km(hours: float, kt: float) -> float:
    return SPEED_FACTOR * max(kt, SPEED_FLOOR_KT) * KM_PER_NM * hours


def _believable(fix: dict, anchor: dict | None) -> bool:
    """The site's spoof rule: False for a fix it would set aside."""
    p = fix.get("pressure_hpa")
    if p is not None and p > 0 and abs(pressure_altitude_m(p) - fix["altitude_m"]) > SPOOF_ALTITUDE_GAP_M:
        return False
    if anchor is None:
        return True
    km = haversine_km(anchor["lat"], anchor["lon"], fix["lat"], fix["lon"])
    return km <= SPOOF_MAX_SPEED_KT * KM_PER_NM * _hours(fix["utc"], anchor["utc"]) + GRID6_SLACK_KM


class _Squares:
    """Our Regular messages by cycle, each cycle's square put to a vote
    by distinct station, as regular_only_slots does. A tied cycle has no
    square."""

    def __init__(self, regulars: list[dict]):
        by_cycle: dict[str, dict[str, set]] = {}
        first_spot: dict[tuple, dict] = {}
        for spot in regulars:
            grid4 = (spot["tx_loc"] or "")[:4].upper()
            if len(grid4) != 4:
                continue
            by_cycle.setdefault(spot["time"], {}).setdefault(grid4, set()).add(spot["rx_sign"])
            # The spot that lends the square: the lowest id, so the choice
            # does not depend on the order rows arrive in.
            have = first_spot.get((spot["time"], grid4))
            if have is None or int(spot["id"]) < int(have["id"]):
                first_spot[(spot["time"], grid4)] = spot
        self.grid: dict[str, str | None] = {}
        self.spot: dict[str, dict] = {}
        for cycle, by_grid in by_cycle.items():
            ranked = Counter({g: len(r) for g, r in by_grid.items()}).most_common(2)
            if len(ranked) == 2 and ranked[0][1] == ranked[1][1]:
                self.grid[cycle] = None
                continue
            self.grid[cycle] = ranked[0][0]
            self.spot[cycle] = first_spot[(cycle, ranked[0][0])]
        self.cycles = sorted(self.grid)

    def before(self, cycle: str) -> str | None:
        prior = [c for c in self.cycles if c < cycle]
        return prior[-1] if prior else None

    def after(self, cycle: str) -> str | None:
        later = [c for c in self.cycles if c > cycle]
        return later[0] if later else None

    def square_for(self, cycle: str) -> tuple[str | None, dict | None, str]:
        """(grid4, the Regular spot lending it, how it was found). grid4 is
        None when no square can be given, with the reason."""
        if cycle in self.grid:
            g = self.grid[cycle]
            if g is None:
                return None, None, "this cycle's Regular reports disagree"
            return g, self.spot[cycle], f"same cycle {g}"
        b, a = self.before(cycle), self.after(cycle)
        t = _t(cycle)
        if b is None or t - _t(b) > NEIGHBOUR_WINDOW:
            return None, None, "no Regular heard in or just before this cycle"
        if a is None or _t(a) - t > NEIGHBOUR_WINDOW:
            return None, None, "no Regular heard in or just after this cycle"
        gb, ga = self.grid[b], self.grid[a]
        if gb is None or ga is None:
            return None, None, "a neighbouring cycle's Regular reports disagree"
        if gb != ga:
            return None, None, f"neighbours disagree: {b[11:16]} {gb}, {a[11:16]} {ga}"
        return gb, self.spot[b], f"neighbours {b[11:16]}+{a[11:16]} {gb}"


def _payloads(spots: list[dict], channel: Channel) -> dict[tuple, list[dict]]:
    """One entry per distinct message in a slot, with the in-lane reports
    of it. A message no station reported inside the lane is left out."""
    out: dict[tuple, list[dict]] = {}
    for s in spots:
        if not in_lane(s["frequency"], channel):
            continue
        key = (s["tx_sign"], s["tx_loc"], int(s["power"]))
        out.setdefault(key, []).append(s)
    return out


def _receivers(reports: list[dict]) -> int:
    return len({s["rx_sign"] for s in reports})


def _plausible_position(lat: float, lon: float, cycle: str, kt: float, slack_km: float,
                        anchor: dict | None, squares: _Squares) -> str | None:
    """None when the position passes, otherwise why it does not."""
    if anchor is None:
        return "no earlier believed fix to check against"
    km = haversine_km(anchor["lat"], anchor["lon"], lat, lon)
    allowed = _reach_km(_hours(cycle, anchor["utc"]), kt) + slack_km + GRID6_SLACK_KM
    if km > allowed:
        return (f"{km:.0f} km from the {anchor['utc'][5:16]} fix, "
                f"more than {allowed:.0f} km allowed")
    # The Regular squares either side of the cycle: the track must pass
    # through them on its way in and out.
    for other in (squares.before(cycle), squares.after(cycle)):
        if other is None or squares.grid[other] is None:
            continue
        glat, glon = maidenhead_to_latlon(squares.grid[other])
        km = haversine_km(glat, glon, lat, lon)
        allowed = _reach_km(_hours(cycle, other), kt) + slack_km + GRID4_SLACK_KM
        if km > allowed:
            return (f"{km:.0f} km from the {other[11:16]} square {squares.grid[other]}, "
                    f"more than {allowed:.0f} km allowed")
    return None


def infer(channel: Channel, flight_id: str, regulars: list[dict],
          telemetry_spots: list[dict], sensor_spots: list[dict],
          fixes: list[dict], confirmed_basic: set[str],
          confirmed_sensor: set[str]) -> Inferred:
    """The inferred tier for one flight.

    `fixes` is every fix already known, oldest first: the confirmed ones
    from this rebuild, and any committed before it (a fix carrying
    `tier == "inferred"` is used to measure distance from, never to define
    float). `confirmed_basic` and `confirmed_sensor` are the cycles the
    confirmed tier already filled; they are left alone.
    """
    squares = _Squares(regulars)
    tel_minute = channel.slot_minute(1)
    sen_minute = channel.slot_minute(BME280_SLOT)

    def by_cycle(spots: list[dict], minute: int) -> dict[str, list[dict]]:
        out: dict[str, list[dict]] = {}
        for s in spots:
            if _t(s["time"]).minute % 10 != minute:
                continue
            out.setdefault(cycle_of(s["time"], channel.start_minute), []).append(s)
        return out

    tel = {c: v for c, v in by_cycle(telemetry_spots, tel_minute).items()
           if c not in confirmed_basic}
    sen = {c: v for c, v in by_cycle(sensor_spots, sen_minute).items()
           if c not in confirmed_sensor}

    # One pass in time order: a known fix moves the anchor (and, when
    # confirmed and believed, the float reference); a cycle's basic
    # message is judged before its sensor message, which may then measure
    # against the fix it produced.
    events = ([(f["utc"], 0, "fix", f) for f in fixes]
              + [(c, 1, "basic", c) for c in tel]
              + [(c, 2, "sensor", c) for c in sen])
    events.sort(key=lambda e: (e[0], e[1]))

    anchor: dict | None = None  # last believed fix, either tier
    float_ref: dict | None = None  # last believed confirmed fix
    fix_at: dict[str, dict] = {f["utc"]: f for f in fixes}
    out_fixes: list[dict] = []
    out_sensors: dict[str, dict] = {}
    decisions: list[Decision] = []

    for _, _, kind, item in events:
        if kind == "fix":
            if _believable(item, anchor):
                anchor = item
                if item.get("tier", "confirmed") != "inferred":
                    float_ref = item
            continue
        cycle = item
        spots = (tel if kind == "basic" else sen)[cycle]
        ids = sorted({int(s["id"]) for s in spots})
        grid4, grid_spot, grid_how = squares.square_for(cycle)
        payloads = _payloads(spots, channel)
        if not payloads:
            decisions.append(Decision(cycle, kind, "rejected", "no report inside the lane", ids))
            continue
        passed: list[tuple] = []
        why: list[str] = []
        for key, reports in sorted(payloads.items()):
            cs, loc, pwr = key
            label = f"{cs} {loc} {pwr}"
            if kind == "basic":
                try:
                    c = decode_callsign(cs)
                    g = decode_grid_power(loc, pwr)
                except ValueError:
                    why.append(f"{label}: not basic telemetry")
                    continue
                if g.hdr_type != 1:
                    why.append(f"{label}: not basic telemetry")
                    continue
                if not g.gps_valid:
                    why.append(f"{label}: GPS not valid")
                    continue
                if grid4 is None:
                    why.append(f"{label}: {grid_how}")
                    continue
                grid6 = grid4 + c.grid5.lower() + c.grid6.lower()
                lat, lon = maidenhead_to_latlon(grid6)
                bad = _plausible_position(lat, lon, cycle, g.speed_knots, GRID6_SLACK_KM,
                                          anchor, squares)
                if bad is None:
                    if float_ref is None:
                        bad = "no earlier confirmed fix to take float from"
                    elif abs(c.altitude_m - float_ref["altitude_m"]) > MAX_FLOAT_DEPARTURE_M:
                        bad = (f"altitude {c.altitude_m} m is more than {MAX_FLOAT_DEPARTURE_M} m "
                               f"from float, {float_ref['altitude_m']} m at {float_ref['utc'][5:16]}")
                if bad is not None:
                    why.append(f"{label}: {bad}")
                    continue
                passed.append((key, reports, {
                    "grid6": grid6, "lat": lat, "lon": lon, "altitude_m": c.altitude_m,
                    "speed_knots": g.speed_knots, "voltage_v": g.voltage_v,
                    "temperature_c": g.temperature_c, "gps_valid": int(g.gps_valid),
                }))
            else:
                try:
                    r = decode_bme280_slot3(cs, loc, pwr)
                except ValueError:
                    why.append(f"{label}: not the sensor message")
                    continue
                if r.sensor_failed:
                    why.append(f"{label}: the sensor did not answer")
                    continue
                if grid4 is None:
                    why.append(f"{label}: {grid_how}")
                    continue
                glat, glon = maidenhead_to_latlon(grid4)
                own = fix_at.get(cycle)
                bad = None
                if own is None:
                    bad = _plausible_position(glat, glon, cycle, 0, GRID4_SLACK_KM, anchor, squares)
                ref = own or float_ref
                if bad is None:
                    if ref is None:
                        bad = "no earlier confirmed fix to take float from"
                    elif abs(pressure_altitude_m(r.pressure_hpa) - ref["altitude_m"]) > MAX_FLOAT_DEPARTURE_M:
                        bad = (f"pressure altitude {pressure_altitude_m(r.pressure_hpa):.0f} m is more "
                               f"than {MAX_FLOAT_DEPARTURE_M} m from {ref['altitude_m']} m "
                               f"at {ref['utc'][5:16]}")
                if bad is not None:
                    why.append(f"{label}: {bad}")
                    continue
                passed.append((key, reports, {
                    "pressure_hpa": r.pressure_hpa, "board_temp_c": r.temperature_c,
                    "humidity_pct": r.humidity_pct,
                }))

        if not passed:
            outcome = ("unplaced" if grid4 is None and any(grid_how in w for w in why)
                       else "rejected")
            decisions.append(Decision(cycle, kind, outcome, "; ".join(why), ids))
            continue
        if len(passed) > 1:
            names = ", ".join(f"{k[0]} {k[1]} {k[2]}" for k, _, _ in passed)
            decisions.append(Decision(cycle, kind, "ambiguous",
                                      f"{len(passed)} messages pass: {names}", ids))
            continue

        (cs, loc, pwr), reports, fields = passed[0]
        best = min(reports, key=lambda s: (s["rx_sign"], int(s["id"])))
        freqs = sorted({int(s["frequency"]) for s in reports})
        reason = (f"cross-receiver; grid {grid_how}; "
                  f"heard by {', '.join(sorted({s['rx_sign'] for s in reports}))} "
                  f"at {'/'.join(str(f) for f in freqs)} Hz; sole candidate")
        decisions.append(Decision(cycle, kind, "inferred", reason, ids))
        if kind == "basic":
            fix = {
                "flight_id": flight_id, "utc": cycle, **fields,
                "rx_station_count": _receivers(reports),
                "regular_spot_id": int(grid_spot["id"]),
                "telemetry_spot_id": int(best["id"]),
                "matcher_name": NAME, "matcher_version": VERSION,
                "tier": "inferred", "pairing": reason,
            }
            out_fixes.append(fix)
            fix_at[cycle] = fix
            anchor = fix
        else:
            out_sensors[cycle] = {
                **fields, "sensor_spot_id": int(best["id"]), "sensor_tier": "inferred",
                "sensor_pairing": reason, "grid4": grid4,
                "rx_station_count": _receivers(reports),
            }
    return Inferred(out_fixes, out_sensors, decisions)
