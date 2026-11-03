"""The inferred pairing tier (picolog/infer.py), against real PT-01 spots.

The vector holds raw wspr.live rows; nothing here touches the network.
The fixtures below were worked out by hand from the raw spots
(docs/cross-receiver-pairing.md), not read back from the pipeline.
"""

import json
from pathlib import Path

import pytest

from picolog import infer
from picolog.channels import channel_table_20m
from picolog.config import Flight
from picolog.match import fingerprint_match
from picolog.pipeline import rebuild_flight_telemetry
from picolog.store import Store

VECTOR = Path(__file__).parent / "vectors" / "pt01_cross_receiver.json"
CH206 = channel_table_20m()[206]


@pytest.fixture(scope="module")
def vector():
    return json.loads(VECTOR.read_text())


@pytest.fixture(scope="module")
def built(vector, tmp_path_factory):
    store = Store(tmp_path_factory.mktemp("db") / "v.db")
    store.insert_spots(vector["raw_spots"])
    rebuild_flight_telemetry(store, Flight(**vector["flight"]))

    def rows(sql):
        cur = store.conn.execute(sql)
        names = [d[0] for d in cur.description]
        return [dict(zip(names, r)) for r in cur.fetchall()]

    yield {
        "telemetry": {r["utc"]: r for r in rows("SELECT * FROM telemetry")},
        "ghosts": {r["utc"]: r for r in rows("SELECT * FROM ghosts")},
        "pairings": {(r["cycle_utc"], r["kind"]): r for r in rows("SELECT * FROM pairings")},
    }
    store.close()


# Basic telemetry heard only by UA9720SWL, our Regular messages only by
# E28AC: (cycle, grid6, lat, lon, altitude m, speed kt, where the square came from).
TIBET_FIXES = [
    ("2026-11-03 04:00:00", "NM21oq", 31.69, 85.21, 10660, 72, "neighbours 03:50+04:20 NM21"),
    ("2026-11-03 07:30:00", "NM52fg", 32.27, 90.46, 10780, 82, "same cycle NM52"),
    ("2026-11-03 08:00:00", "NM52ph", 32.31, 91.29, 10720, 82, "neighbours 07:50+08:10 NM52"),
    ("2026-11-03 08:50:00", "NM62hi", 32.35, 92.62, 10760, 82, "same cycle NM62"),
]


@pytest.mark.parametrize("utc,grid6,lat,lon,alt,kt,source", TIBET_FIXES)
def test_tibet_basic_telemetry_is_inferred(built, utc, grid6, lat, lon, alt, kt, source):
    fix = built["telemetry"][utc]
    assert fix["tier"] == "inferred"
    assert fix["grid6"] == grid6
    assert round(fix["lat"], 2) == lat and round(fix["lon"], 2) == pytest.approx(lon, abs=0.01)
    assert (fix["altitude_m"], fix["speed_knots"], fix["gps_valid"]) == (alt, kt, 1)
    assert f"grid {source}" in fix["pairing"]
    assert "UA9720SWL" in fix["pairing"]
    assert fix["matcher_name"] == "cross-receiver"
    # A cycle filled by the inferred tier is no longer a ghost.
    assert utc not in built["ghosts"]


# Sensor messages, all UA9720SWL: (cycle, temperature C, pressure hPa,
# humidity %, where the reading lands).
TIBET_SENSORS = [
    ("2026-11-03 03:50:00", -11, 252, 0, "ghost NM21"),
    ("2026-11-03 07:40:00", -15, 252, 0, "ghost NM52 neighbours"),
    ("2026-11-03 07:50:00", -6, 257, 0, "ghost NM52"),
    ("2026-11-03 08:30:00", -2, 253, 0, "ghost NM62"),
]


@pytest.mark.parametrize("utc,temp,hpa,hum,where", TIBET_SENSORS)
def test_tibet_sensor_readings_are_inferred(built, utc, temp, hpa, hum, where):
    ghost = built["ghosts"][utc]
    assert (ghost["board_temp_c"], ghost["pressure_hpa"], ghost["humidity_pct"]) == (temp, hpa, hum)
    assert ghost["sensor_tier"] == "inferred"
    _, grid4, *source = where.split()
    assert ghost["grid4"] == grid4
    assert ghost["grid_source"] == (source[0] if source else None)


@pytest.mark.parametrize("utc,why", [
    # 03:16: no Regular in its cycle, and the ones either side disagree,
    # because the balloon crossed from NM11 into NM21 in between.
    ("2026-11-03 03:10:00", "neighbours disagree: 02:50 NM11, 03:30 NM21"),
    # 09:26, near shutdown: nothing heard after 08:50 to bracket it.
    ("2026-11-03 09:20:00", "no Regular heard in or just after this cycle"),
])
def test_unplaceable_sensor_readings_are_reported_not_forced(built, utc, why):
    d = built["pairings"][(utc, "sensor")]
    assert d["outcome"] == "unplaced"
    assert why in d["reason"]
    assert utc not in built["ghosts"] and utc not in built["telemetry"]


def test_nothing_at_minute_x4_is_ever_accepted(vector):
    """Another balloon sends 1?0 in this lane at :x4. Offer every :x4 spot
    of the flight to the inferred tier as both kinds of message: the slot
    check alone must refuse every one."""
    x4 = [s for s in vector["raw_spots"]
          if s["tx_sign"] != "KR4OGH" and int(s["time"][15]) % 10 == 4]
    assert len(x4) == 268
    regulars = [s for s in vector["raw_spots"] if s["tx_sign"] == "KR4OGH"]
    out = infer.infer(CH206, "PT01", regulars, x4, x4,
                      [{"utc": "2026-10-24 15:10:00", "lat": 39.27, "lon": -77.96,
                        "altitude_m": 10800, "tier": "confirmed"}], set(), set())
    assert out.fixes == [] and out.sensors == {} and out.decisions == []


def test_no_minute_x4_spot_lands_on_the_track(built):
    assert not any(utc[15] in "4" for utc in built["telemetry"])


def test_other_balloons_headers_are_refused(built):
    """31 Oct overnight, while PT01 was dark: other 1?0 balloons over North
    America sending basic telemetry in PT01's sensor minute (19:06, 20:26,
    21:26, 22:16), and an extended message with HdrType 15 at :x4 (18:44).
    None of it is PT01's, and none of it lands anywhere."""
    accepted = {u for u, r in built["telemetry"].items() if r["tier"] == "inferred"}
    accepted |= {u for u, g in built["ghosts"].items() if g["sensor_tier"] == "inferred"}
    assert not any("2026-10-31 18:00:00" <= u < "2026-11-01 00:00:00" for u in accepted)
    for cycle in ("2026-10-31 19:00:00", "2026-10-31 20:20:00",
                  "2026-10-31 21:20:00", "2026-10-31 22:10:00"):
        d = built["pairings"][(cycle, "sensor")]
        assert d["outcome"] == "rejected" and "not the sensor message" in d["reason"]


def test_31_oct_slot3_messages_are_pt01s_and_placed_only_when_bracketed(built):
    """The extended messages over the eastern Mediterranean are header
    Type 0 Slot 3, PT01's own format, reading 245-248 hPa. 13:26's cycle
    had no Regular, but 13:10 and 13:30 both heard JM60, so it is placed
    there. 13:46 and 13:56 have no Regular after them within half an hour,
    so they are not."""
    g = built["ghosts"]["2026-10-31 13:20:00"]
    assert (g["pressure_hpa"], g["grid4"], g["grid_source"]) == (247, "JM60", "neighbours")
    for cycle in ("2026-10-31 13:40:00", "2026-10-31 13:50:00"):
        assert built["pairings"][(cycle, "sensor")]["outcome"] == "unplaced"


def test_spoofed_fixes_stay_confirmed(built):
    """1 Nov 12:00 and 12:30, LM43bm at 200 m and 0 kt: paired by the
    same-station fingerprint, and still confirmed. The site's spoof filter
    sets them aside (src/lib/spoof.ts); the pairing tiers do not."""
    for utc in ("2026-11-01 12:00:00", "2026-11-01 12:30:00"):
        fix = built["telemetry"][utc]
        assert (fix["grid6"], fix["altitude_m"], fix["tier"]) == ("LM43bm", 200, "confirmed")


def test_spoofed_fixes_would_fail_the_plausibility_checks():
    """Had they arrived unpaired, both checks would refuse them: 460 km in
    10 minutes, and 10.7 km below float."""
    before = {"utc": "2026-11-01 11:50:00", "lat": 29.47917, "lon": 49.29167,
              "altitude_m": 10920}
    squares = infer._Squares([])
    why = infer._plausible_position(33.52083, 48.125, "2026-11-01 12:00:00", 0,
                                    infer.GRID6_SLACK_KM, before, squares)
    assert why is not None and "km allowed" in why
    assert abs(200 - before["altitude_m"]) > infer.MAX_FLOAT_DEPARTURE_M
    # And a spoofed fix is never the fix an inferred one is measured from.
    assert not infer._believable(
        {"utc": "2026-11-01 12:00:00", "lat": 33.52083, "lon": 48.125,
         "altitude_m": 200, "pressure_hpa": 250}, before)


def test_confirmed_tier_is_exactly_the_fingerprint_match(vector, built):
    """The inferred tier only fills cycles the confirmed tier left empty;
    every confirmed row is what fingerprint pairing alone produces."""
    spots = vector["raw_spots"]
    regulars = [s for s in spots if s["tx_sign"] == "KR4OGH" and int(s["time"][15]) == 0]
    tel = [s for s in spots if s["tx_sign"][0] == "1" and s["tx_sign"][2] == "0"
           and len(s["tx_sign"]) == 6 and int(s["time"][15]) == 2]
    paired = {m.slot_utc: m.telemetry_spot["id"] for m in fingerprint_match(regulars, tel)}
    confirmed = {u: r["telemetry_spot_id"] for u, r in built["telemetry"].items()
                 if r["tier"] == "confirmed"}
    assert confirmed == {u: i for u, i in paired.items() if u in confirmed}
    assert set(paired) - set(confirmed) <= set()  # every one decoded here


def test_ambiguous_slot_accepts_neither():
    """Two different messages in one slot both pass every check: neither
    is accepted, and the cycle is marked ambiguous."""
    def spot(i, time, rx, sign, loc, pwr, freq):
        return {"id": i, "time": time, "rx_sign": rx, "tx_sign": sign, "tx_loc": loc,
                "power": pwr, "frequency": freq}
    regulars = [spot(1, "2026-11-03 07:30:00", "E28AC", "KR4OGH", "NM52", 13, 14097077)]
    tel = [spot(2, "2026-11-03 07:32:00", "UA9720SWL", "170RWL", "KA20", 10, 14097065),
           # the 08:02 message, as if it had been sent at 07:32 too
           spot(3, "2026-11-03 07:32:00", "R1ABC", "1M0IPW", "KK72", 23, 14097066)]
    fixes = [{"utc": "2026-11-03 04:00:00", "lat": 31.6875, "lon": 85.20833,
              "altitude_m": 10660, "tier": "confirmed"}]
    out = infer.infer(CH206, "PT01", regulars, tel, [], fixes, set(), set())
    assert out.fixes == []
    (d,) = out.decisions
    assert d.outcome == "ambiguous" and d.cycle_utc == "2026-11-03 07:30:00"


def test_out_of_lane_report_is_refused():
    def spot(i, time, rx, sign, loc, pwr, freq):
        return {"id": i, "time": time, "rx_sign": rx, "tx_sign": sign, "tx_loc": loc,
                "power": pwr, "frequency": freq}
    regulars = [spot(1, "2026-11-03 07:30:00", "E28AC", "KR4OGH", "NM52", 13, 14097077)]
    tel = [spot(2, "2026-11-03 07:32:00", "UA9720SWL", "170RWL", "KA20", 10, 14097140)]
    fixes = [{"utc": "2026-11-03 04:00:00", "lat": 31.6875, "lon": 85.20833,
              "altitude_m": 10660, "tier": "confirmed"}]
    out = infer.infer(CH206, "PT01", regulars, tel, [], fixes, set(), set())
    assert out.fixes == [] and out.decisions[0].reason == "no report inside the lane"


def test_an_inferred_fix_does_not_redefine_float():
    """A run of inferred fixes each 1,000 m lower than the last would walk
    float down if each were measured against the one before it. They are
    measured against the last confirmed fix, so the second is refused."""
    def spot(i, time, rx, sign, loc, pwr, freq=14097065):
        return {"id": i, "time": time, "rx_sign": rx, "tx_sign": sign, "tx_loc": loc,
                "power": pwr, "frequency": freq}
    from picolog.decode import decode_callsign
    # The real 07:32 and 08:02 NM52 messages, with float set high.
    regulars = [spot(1, "2026-11-03 07:30:00", "E28AC", "KR4OGH", "NM52", 13),
                spot(2, "2026-11-03 08:00:00", "E28AC", "KR4OGH", "NM52", 13)]
    tel = [spot(3, "2026-11-03 07:32:00", "UA9720SWL", "170RWL", "KA20", 10),
           spot(4, "2026-11-03 08:02:00", "UA9720SWL", "1M0IPW", "KK72", 23)]
    assert decode_callsign("170RWL").altitude_m == 10780
    assert decode_callsign("1M0IPW").altitude_m == 10720
    # Float is 12,250 m: 10,780 is 1,470 below (accepted). 10,720 is 1,530
    # below and refused, though it is only 60 m from the 10,780 just
    # accepted, and an inferred 12,000 m fix in between does not move
    # float either.
    fixes = [{"utc": "2026-11-03 04:00:00", "lat": 31.6875, "lon": 85.20833,
              "altitude_m": 12250, "tier": "confirmed"},
             {"utc": "2026-11-03 05:00:00", "lat": 31.9, "lon": 87.0,
              "altitude_m": 12000, "tier": "inferred"}]
    out = infer.infer(CH206, "PT01", regulars, tel, [], fixes, set(), set())
    assert [f["utc"] for f in out.fixes] == ["2026-11-03 07:30:00"]
    assert "from float, 12250 m" in out.decisions[1].reason


def test_frozen_output(vector, built):
    """The vector's expected rows are this pipeline's, frozen; the
    TypeScript port is held to the same (dev/verify-port.ts)."""
    assert built["telemetry"] == {r["utc"]: r for r in vector["expected_telemetry"]}
    assert built["ghosts"] == {r["utc"]: r for r in vector["expected_ghosts"]}
    assert built["pairings"] == {(r["cycle_utc"], r["kind"]): r
                                 for r in vector["expected_pairings"]}
