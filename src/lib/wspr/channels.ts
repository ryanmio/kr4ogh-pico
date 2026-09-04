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
