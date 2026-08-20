"""20 m channel table: channel number -> (id13, start minute, frequency).

The table is a frozen CSV, not a formula. The generating formula was validated
against 67 real flights from the Traquito Flight Log before freezing (zero
disagreements on id13 or start minute; see docs/decode-status.md), but a wrong
formula in the lookup path would silently attribute spots to the wrong flight,
so the hot path only ever reads the reviewed file.

Channel scheme: https://qrp-labs.com/u4b/u4bdecoding.html and
https://traquito.github.io/channelmap/help/
"""

import csv
from dataclasses import dataclass
from functools import cache
from pathlib import Path


@dataclass(frozen=True)
class Channel:
    channel: int
    id13: str
    start_minute: int
    frequency_hz: int

    @property
    def telemetry_minute(self) -> int:
        # Telemetry goes out in the slot after the Regular message
        # (https://traquito.github.io/channelmap/help/).
        return (self.start_minute + 2) % 10


@cache
def channel_table_20m() -> dict[int, Channel]:
    path = Path(__file__).with_name("channels_20m.csv")
    table = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            ch = Channel(
                channel=int(row["channel"]),
                id13=row["id13"],
                start_minute=int(row["start_minute"]),
                frequency_hz=int(row["frequency_hz"]),
            )
            table[ch.channel] = ch
    return table
