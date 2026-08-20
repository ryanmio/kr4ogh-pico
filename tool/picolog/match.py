"""Pair Regular and Telemetry spots by receiver fingerprint.

A pairing requires the SAME receiving station to have reported both messages,
in consecutive 2-minute slots, with reported frequencies within tolerance OF
EACH OTHER — not within tolerance of the channel's nominal frequency.
Receiver calibration error is routine and shifts both reports by the same
amount, so it cancels in the comparison; matching against nominal instead
would silently discard good data and pollute other operators' flights
(https://traquito.github.io/pro/telemetry/channels/, "Fingerprinting").

Known limitation: this method needs one station to hear both packets. Measured
by G0UPL over VE3KCL's U4B-40 flight, that requirement loses roughly 6% of
otherwise-recoverable records (720 lost of 12,469), concentrated where
receiver density is low — over oceans
(https://qrp-labs.com/u4b/u4bdecoding.html). Receiver-error-correction
matching is the intended alternative, and is why raw spots are retained in the
local store.
"""

from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta

NAME = "fingerprint"
VERSION = 1

# Both reports pass through the same receiver error, so the residual
# difference is transmitter drift plus reporting jitter: a few Hz. 5 Hz held
# over the 67-flight channel validation (docs/decode-status.md).
DEFAULT_TOLERANCE_HZ = 5


@dataclass(frozen=True)
class Match:
    slot_utc: str  # time of the Regular message's slot
    regular_spot: dict
    telemetry_spot: dict
    rx_station_count: int  # stations whose reports confirm this pairing


def fingerprint_match(regular_spots: list[dict], telemetry_spots: list[dict],
                      tolerance_hz: int = DEFAULT_TOLERANCE_HZ) -> list[Match]:
    """Pair Regular spots with Telemetry spots, one Match per Regular slot.

    Inputs are raw wspr.live rows. The telemetry payload identity is the
    decoded WSPR content (tx_sign, tx_loc, power): every station that heard
    the same transmission reports the same content. When several stations
    confirm the same payload the match carries their count; if two different
    payloads tie for a slot, the slot is skipped rather than guessed at.
    """
    reg_by_slot: dict[str, dict[str, dict]] = {}
    for spot in regular_spots:
        # one report per receiver per slot; wsprnet data can contain duplicates
        reg_by_slot.setdefault(spot["time"], {}).setdefault(spot["rx_sign"], spot)

    tel_by_slot: dict[str, list[dict]] = {}
    for spot in telemetry_spots:
        tel_by_slot.setdefault(spot["time"], []).append(spot)

    matches = []
    for slot, reg_by_rx in sorted(reg_by_slot.items()):
        tel_slot = _plus_two_minutes(slot)
        votes: Counter = Counter()
        evidence: dict[tuple, tuple[dict, dict]] = {}
        seen_rx: dict[tuple, set] = {}
        for tel in tel_by_slot.get(tel_slot, ()):
            reg = reg_by_rx.get(tel["rx_sign"])
            if reg is None:
                continue
            if abs(int(tel["frequency"]) - int(reg["frequency"])) > tolerance_hz:
                continue
            payload = (tel["tx_sign"], tel["tx_loc"], int(tel["power"]))
            if tel["rx_sign"] in seen_rx.setdefault(payload, set()):
                continue
            seen_rx[payload].add(tel["rx_sign"])
            votes[payload] += 1
            evidence.setdefault(payload, (reg, tel))
        if not votes:
            continue
        ranked = votes.most_common(2)
        if len(ranked) == 2 and ranked[0][1] == ranked[1][1]:
            continue  # two payloads with equal support: ambiguous, skip
        payload, count = ranked[0]
        reg, tel = evidence[payload]
        matches.append(Match(slot_utc=slot, regular_spot=reg,
                             telemetry_spot=tel, rx_station_count=count))
    return matches


def _plus_two_minutes(slot: str) -> str:
    t = datetime.fromisoformat(slot)
    return (t + timedelta(minutes=2)).strftime("%Y-%m-%d %H:%M:%S")
