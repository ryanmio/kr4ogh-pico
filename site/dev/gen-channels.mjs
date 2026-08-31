// Generate the browser's copy of the frozen 20 m channel table from the
// authoritative CSV in tool/picolog/. The table is frozen (see
// tool/picolog/channels.py): a wrong entry would silently attribute spots to
// the wrong flight, so the browser reads a generated copy of the reviewed
// file rather than recomputing the formula.
//
// The CSV is stored with CRLF endings, so rows are split on /\r?\n/ and every
// parsed value is validated: a malformed cell must fail loudly here, not turn
// into a null that only shows up as a wrong frequency at runtime.
//
// Re-run after any change to channels_20m.csv:  node dev/gen-channels.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const csv = readFileSync(join(here, "../../tool/picolog/channels_20m.csv"), "utf8");
const [header, ...lines] = csv.trim().split(/\r?\n/);
const cols = header.split(",").map((c) => c.trim());

const want = ["channel", "id13", "start_minute", "frequency_hz"];
for (const c of want) {
  if (!cols.includes(c)) throw new Error(`channels CSV is missing column ${c}`);
}

const table = {};
for (const line of lines) {
  const cells = line.split(",").map((v) => v.trim());
  const row = Object.fromEntries(cells.map((v, i) => [cols[i], v]));
  const channel = Number(row.channel);
  const startMinute = Number(row.start_minute);
  const frequencyHz = Number(row.frequency_hz);
  if (!Number.isInteger(channel) || !Number.isInteger(startMinute)
      || !Number.isInteger(frequencyHz) || !/^[01Q]\d$/.test(row.id13)) {
    throw new Error(`malformed channel row: ${JSON.stringify(line)}`);
  }
  table[channel] = [row.id13, startMinute, frequencyHz];
}

const out = join(here, "../src/lib/wspr/channels-20m.json");
writeFileSync(out, JSON.stringify(table));
console.log(`wrote ${Object.keys(table).length} channels to ${out}`);
