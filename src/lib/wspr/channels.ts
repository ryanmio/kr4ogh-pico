/** 20 m channel table: channel number -> id13, start minute, frequency.
 *
 * The table is a frozen CSV in tool/picolog/, not a formula. The generating
 * formula was validated against 67 real flights before freezing, but a wrong
 * formula in the lookup path would silently attribute spots to the wrong
 * flight, so this reads a generated copy of the reviewed file. Regenerate
 * with `node dev/gen-channels.mjs`.
 */
import table from "./channels-20m.json";

export interface Channel {
  channel: number;
  id13: string;
  startMinute: number;
  frequencyHz: number;
  /** Telemetry goes out in the slot after the Regular message. */
  telemetryMinute: number;
}

/** The minute of one of the cycle's five 2-minute slots, counted from the
 * Regular message's: slot 0 is the Regular message, slot 1 Basic Telemetry,
 * slot 3 the Petrel sensor message. This is the numbering the Traquito
 * dashboard and Copilot use, and the one the HdrSlot header carries on the
 * air. Mirrors tool/picolog/channels.py's slot_minute. */
export function slotMinute(ch: Channel, slot: number): number {
  if (!Number.isInteger(slot) || slot < 0 || slot > 4) {
    throw new Error(`slot must be 0-4: ${slot}`);
  }
  return (ch.startMinute + 2 * slot) % 10;
}

// The generated JSON widens to (string | number)[]; the generator validates
// the shape of every row, so narrowing here is safe.
const raw = table as unknown as Record<string, [string, number, number]>;

export function channel20m(channel: number): Channel {
  const row = raw[String(channel)];
  if (!row) throw new Error(`unknown 20 m channel: ${channel}`);
  const [id13, startMinute, frequencyHz] = row;
  return {
    channel,
    id13,
    startMinute,
    frequencyHz,
    telemetryMinute: (startMinute + 2) % 10,
  };
}
