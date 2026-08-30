/** Pair Regular and Telemetry spots by receiver fingerprint.
 *
 * A direct port of tool/picolog/match.py. A pairing requires the SAME
 * receiving station to have reported both messages, in consecutive 2-minute
 * slots, with reported frequencies within tolerance OF EACH OTHER, not of the
 * channel's nominal frequency. Receiver calibration error shifts both reports
 * equally and cancels; matching against nominal would discard good data and
 * pollute other operators' flights.
 *
 * Known limitation: one station must hear both packets. Measured over a
 * U4B-40 flight, that loses roughly 6% of otherwise-recoverable records,
 * concentrated where receiver density is low, over oceans.
 */
import type { Spot } from "./query";

export const MATCHER_NAME = "fingerprint";
export const MATCHER_VERSION = 1;

/** Both reports pass through the same receiver error, so the residual is
 * transmitter drift plus reporting jitter: a few Hz. 5 Hz held over the
 * 67-flight channel validation. */
export const DEFAULT_TOLERANCE_HZ = 5;

export interface Match {
  slotUtc: string; // time of the Regular message's slot
  regularSpot: Spot;
  telemetrySpot: Spot;
  rxStationCount: number; // stations whose reports confirm this pairing
}

/** Pair Regular spots with Telemetry spots, one Match per Regular slot.
 *
 * The telemetry payload identity is the decoded WSPR content (tx_sign,
 * tx_loc, power): every station that heard the same transmission reports the
 * same content. When several stations confirm the same payload the match
 * carries their count; if two payloads tie for a slot, the slot is skipped
 * rather than guessed at.
 */
export function fingerprintMatch(
  regularSpots: Spot[],
  telemetrySpots: Spot[],
  toleranceHz: number = DEFAULT_TOLERANCE_HZ,
): Match[] {
  // one report per receiver per slot; wsprnet data can contain duplicates
  const regBySlot = new Map<string, Map<string, Spot>>();
  for (const spot of regularSpots) {
    let byRx = regBySlot.get(spot.time);
    if (!byRx) regBySlot.set(spot.time, (byRx = new Map()));
    if (!byRx.has(spot.rx_sign)) byRx.set(spot.rx_sign, spot);
  }

  const telBySlot = new Map<string, Spot[]>();
  for (const spot of telemetrySpots) {
    const list = telBySlot.get(spot.time);
    if (list) list.push(spot);
    else telBySlot.set(spot.time, [spot]);
  }

  const matches: Match[] = [];
  for (const slot of [...regBySlot.keys()].sort()) {
    const regByRx = regBySlot.get(slot)!;
    const telSlot = plusTwoMinutes(slot);
    const votes = new Map<string, number>();
    const evidence = new Map<string, [Spot, Spot]>();
    const seenRx = new Map<string, Set<string>>();

    for (const tel of telBySlot.get(telSlot) ?? []) {
      const reg = regByRx.get(tel.rx_sign);
      if (reg === undefined) continue;
      if (Math.abs(Number(tel.frequency) - Number(reg.frequency)) > toleranceHz) {
        continue;
      }
      // Payload identity as a Map key. NUL separates the parts because no
      // WSPR field can contain it, so distinct payloads cannot collide
      // into one key; written as an escape so this file stays text.
      const payload = [tel.tx_sign, tel.tx_loc, Number(tel.power)].join("\u0000");
      let rxSeen = seenRx.get(payload);
      if (!rxSeen) seenRx.set(payload, (rxSeen = new Set()));
      if (rxSeen.has(tel.rx_sign)) continue;
      rxSeen.add(tel.rx_sign);
      votes.set(payload, (votes.get(payload) ?? 0) + 1);
      if (!evidence.has(payload)) evidence.set(payload, [reg, tel]);
    }
    if (votes.size === 0) continue;

    // Python's Counter.most_common(2): highest count first, insertion order
    // breaking ties. Array.prototype.sort is stable, so the same rule holds.
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
    if (ranked.length === 2 && ranked[0][1] === ranked[1][1]) continue; // ambiguous
    const [payload, count] = ranked[0];
    const [reg, tel] = evidence.get(payload)!;
    matches.push({
      slotUtc: slot,
      regularSpot: reg,
      telemetrySpot: tel,
      rxStationCount: count,
    });
  }
  return matches;
}

function plusTwoMinutes(slot: string): string {
  const t = new Date(slot.replace(" ", "T") + "Z");
  t.setUTCMinutes(t.getUTCMinutes() + 2);
  return t.toISOString().slice(0, 19).replace("T", " ");
}
