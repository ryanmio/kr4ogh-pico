/** The site's configuration: flights.toml at the repo root, read at build
 * time. That file is the one thing to edit to run this site for another
 * callsign, so the checks here are written for the person editing it: each
 * failure names the field and says what was expected, because the first
 * place a mistake shows up is a failed Vercel build.
 *
 * tool/picolog/config.py reads the same file with the same rules, so the
 * tool and the site never disagree about what is flying. Build-time only:
 * nothing here reaches the browser except what a page chooses to embed.
 */
import { readFileSync } from "node:fs";
import { parse, TomlError } from "smol-toml";
import type { FlightMeta, SiteConfig, TrackPoint } from "./types";
import { maidenheadToLatLon } from "./wspr/decode";

/** The project this site is an instance of. The "Fly your own" link, and
 * the source link of last resort. */
export const UPSTREAM_REPO = "https://github.com/ryanmio/kr4ogh-pico";

const CONFIG_URL = new URL("../../flights.toml", import.meta.url);

// Mirrors tool/picolog/config.py.
const BANDS = ["20m"];
const FLIGHT_ID = /^[A-Za-z0-9_-]{1,32}$/;
const CALLSIGN = /^[A-Z0-9/]{3,10}$/;
const LAUNCH_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const FLIGHT_FIELDS = new Set([
  "flight_id", "callsign", "band", "channel", "active", "launch_utc", "end_utc",
  "launch_lat", "launch_lon", "status", "close_reason", "float_m", "tracker",
  "sensor", "spoofed",
]);
const GRID6 = /^[A-R]{2}[0-9]{2}[a-x]{2}$/i;
const SPOOFED_NUMBERS = [
  "altitude_m", "speed_kt", "voltage_v", "temperature_c", "rx_station_count",
] as const;
const SPOOFED_FIELDS = new Set(["utc", "grid6", "note", ...SPOOFED_NUMBERS]);
/** Sensors a tracker can declare. "bme280" is the Petrel tracker's board
 * sensor, sent as extended telemetry in slot 3 (lib/wspr/decode.ts). */
const SENSORS = ["bme280"] as const;

type Table = Record<string, unknown>;

function fail(where: string, msg: string): never {
  throw new Error(`flights.toml: ${where}: ${msg}`);
}

function isTable(v: unknown): v is Table {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionalText(t: Table, where: string, key: string): string | null {
  const v = t[key];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") fail(`${where}.${key}`, "must be text in quotes");
  return v;
}

/** A "YYYY-MM-DD HH:MM:SS" UTC timestamp, or null when absent. The form is
 * fixed so that two of them compare as text. */
function utcText(t: Table, where: string, key: string): string | null {
  const v = optionalText(t, where, key);
  if (v === null) return null;
  if (!LAUNCH_UTC.test(v)) {
    fail(`${where}.${key}`, 'must look like "2026-08-30 12:44:00" (UTC, in quotes)');
  }
  if (Number.isNaN(Date.parse(v.replace(" ", "T") + "Z"))) {
    fail(`${where}.${key}`, `"${v}" is not a real date and time`);
  }
  return v;
}

function optionalNumber(t: Table, where: string, key: string): number | null {
  const v = t[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number") fail(`${where}.${key}`, "must be a number");
  return v;
}

function flight(entry: unknown, index: number): FlightMeta {
  let where = `[[flights]] #${index + 1}`;
  if (!isTable(entry)) fail(where, "must be a table");
  for (const key of Object.keys(entry)) {
    if (!FLIGHT_FIELDS.has(key)) {
      fail(`${where}.${key}`, "unknown field; see the comments at the top of the file");
    }
  }

  const flightId = entry.flight_id;
  if (typeof flightId !== "string" || !FLIGHT_ID.test(flightId)) {
    fail(`${where}.flight_id`,
      'required; letters, digits, "-" or "_" only, e.g. "F1" (it is used in the URL)');
  }
  where = `[[flights]] ${flightId}`;

  if (typeof entry.callsign !== "string") fail(`${where}.callsign`, 'required, e.g. "N0CALL"');
  const callsign = entry.callsign.trim().toUpperCase();
  if (!CALLSIGN.test(callsign)) {
    fail(`${where}.callsign`, `"${entry.callsign}" does not look like a callsign`);
  }

  const band = entry.band;
  if (typeof band !== "string" || !BANDS.includes(band)) {
    fail(`${where}.band`, `must be one of ${JSON.stringify(BANDS)} (only 20 m is supported so far)`);
  }

  const channel = entry.channel;
  if (typeof channel !== "number" || !Number.isInteger(channel) || channel < 0 || channel > 599) {
    fail(`${where}.channel`, "must be a whole number from 0 to 599 (the Traquito channel)");
  }

  const active = entry.active ?? true;
  if (typeof active !== "boolean") fail(`${where}.active`, "must be true or false");

  const launchUtc = utcText(entry, where, "launch_utc");
  const endUtc = utcText(entry, where, "end_utc");
  if (launchUtc !== null && endUtc !== null && endUtc <= launchUtc) {
    fail(`${where}.end_utc`, `"${endUtc}" is not after launch_utc "${launchUtc}"`);
  }

  const status = entry.status ?? "live";
  if (status !== "live" && status !== "closed") {
    fail(`${where}.status`, 'must be "live" or "closed"');
  }

  const floatM = optionalNumber(entry, where, "float_m");
  if (floatM !== null && !(floatM > 0 && floatM < 50_000)) {
    fail(`${where}.float_m`, "must be metres above sea level, e.g. 10700");
  }

  const sensor = optionalText(entry, where, "sensor");
  if (sensor !== null && !(SENSORS as readonly string[]).includes(sensor)) {
    fail(`${where}.sensor`, `must be one of ${JSON.stringify(SENSORS)}, or left out`);
  }

  let tracker: Record<string, string> | undefined;
  if (entry.tracker !== undefined) {
    if (!isTable(entry.tracker)) {
      fail(`${where}.tracker`, "must be a table of label = value lines");
    }
    // Every line after a [flights.tracker] header belongs to that table, so
    // `status = "closed"` added at the bottom of an entry lands here and the
    // flight would silently stay live. Labels are written capitalised and
    // quoted ("Hardware"), so a bare flight setting here is that mistake.
    const strayed = Object.keys(entry.tracker).find((k) => FLIGHT_FIELDS.has(k));
    if (strayed !== undefined) {
      fail(
        `${where}.tracker.${strayed}`,
        `this is a flight setting, but it sits under [flights.tracker], so it ` +
        `would be shown as a label instead of taking effect. Move it above ` +
        `the [flights.tracker] line`,
      );
    }
    tracker = Object.fromEntries(
      Object.entries(entry.tracker).map(([k, v]) => [k, String(v)]),
    );
  }

  const spoofed = handSpoofed(entry.spoofed, where, launchUtc, endUtc);

  return {
    flight_id: flightId,
    callsign,
    band,
    channel,
    active,
    launch_utc: launchUtc,
    end_utc: endUtc,
    launch_lat: optionalNumber(entry, where, "launch_lat"),
    launch_lon: optionalNumber(entry, where, "launch_lon"),
    status,
    close_reason: optionalText(entry, where, "close_reason"),
    float_m: floatM,
    ...(tracker ? { tracker } : {}),
    ...(sensor ? { sensor: sensor as (typeof SENSORS)[number] } : {}),
    ...(spoofed.length ? { spoofed } : {}),
  };
}

/** The [[flights.spoofed]] entries: fixes set aside as spoofed by hand.
 * Strict, because each one puts a point on a public map that no decoder
 * vouched for: every field is required, a note must say why, and the time
 * must fall inside the flight, so a typo cannot land a point on the wrong
 * flight or leave one unexplained. */
function handSpoofed(
  v: unknown, where: string, launchUtc: string | null, endUtc: string | null,
): TrackPoint[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(`${where}.spoofed`, "must be [[flights.spoofed]] entries");
  return v.map((e, i) => {
    const at = `${where}.spoofed #${i + 1}`;
    if (!isTable(e)) fail(at, "must be a table");
    for (const key of Object.keys(e)) {
      if (!SPOOFED_FIELDS.has(key)) fail(`${at}.${key}`, "unknown field");
    }
    const utc = utcText(e, at, "utc");
    if (utc === null) fail(`${at}.utc`, 'required, e.g. "2026-11-14 11:36:00"');
    if (launchUtc === null) fail(at, "the flight needs a launch_utc to check this against");
    if (utc < launchUtc || (endUtc !== null && utc > endUtc)) {
      fail(`${at}.utc`, `"${utc}" is outside this flight (${launchUtc} to ${endUtc ?? "now"})`);
    }
    const grid6 = e.grid6;
    if (typeof grid6 !== "string" || !GRID6.test(grid6)) {
      fail(`${at}.grid6`, 'required, a 6-character locator such as "FH17lx"');
    }
    const note = optionalText(e, at, "note");
    if (note === null || !note.trim()) {
      fail(`${at}.note`, "required: say why this fix is taken to be spoofed");
    }
    const nums = Object.fromEntries(SPOOFED_NUMBERS.map((k) => {
      const n = optionalNumber(e, at, k);
      if (n === null || !Number.isFinite(n)) fail(`${at}.${k}`, "required, a number");
      return [k, n];
    })) as Record<(typeof SPOOFED_NUMBERS)[number], number>;
    const [lat, lon] = maidenheadToLatLon(grid6);
    return {
      utc, grid6: grid6.slice(0, 4).toUpperCase() + grid6.slice(4).toLowerCase(),
      lat, lon, ...nums,
      // A position can only be spoofed if the GPS called it valid.
      gps_valid: true,
      spoof_note: note.trim(),
    };
  });
}

function load(): { site: SiteConfig; flights: FlightMeta[] } {
  let text: string;
  try {
    text = readFileSync(CONFIG_URL, "utf8");
  } catch {
    fail("", "not found (expected at the repo root)");
  }
  return parseConfig(text);
}

/** flights.toml's text to the site and its flights, or a thrown error
 * naming what is wrong. Exported for the dev checks. */
export function parseConfig(text: string): { site: SiteConfig; flights: FlightMeta[] } {
  let doc: Table;
  try {
    doc = parse(text);
  } catch (err) {
    if (err instanceof TomlError) fail("", `not valid TOML\n${err.message}`);
    throw err;
  }

  const site = doc.site;
  if (!isTable(site)) fail("[site]", "required: a [site] table with at least a callsign");
  if (typeof site.callsign !== "string" || !CALLSIGN.test(site.callsign.trim().toUpperCase())) {
    fail("[site].callsign", 'required, e.g. "N0CALL"');
  }
  const env = process.env;
  // Vercel names the production host and the repo it deploys from, so an
  // instance deployed there needs neither in the file. An explicit value
  // wins; SITE_URL stays as the escape hatch it always was.
  const vercelUrl = env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : null;
  const vercelRepo =
    env.VERCEL_GIT_PROVIDER === "github" && env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG
      ? `https://github.com/${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}` : null;
  for (const key of ["url", "repo"]) {
    const v = optionalText(site, "[site]", key);
    if (v !== null && !/^https?:\/\//.test(v)) fail(`[site].${key}`, 'must start with "https://"');
  }

  const entries = doc.flights ?? [];
  if (!Array.isArray(entries)) fail("flights", "must be written as [[flights]] tables");
  const flights = entries.map(flight);
  const seen = new Set<string>();
  for (const f of flights) {
    if (seen.has(f.flight_id)) fail(`[[flights]] ${f.flight_id}`, "flight_id used twice");
    seen.add(f.flight_id);
  }

  // Mirrors tool/picolog/export_site.py: a flight is on the site while it
  // is active, and once it is closed; a parked one is not.
  const featured = optionalText(site, "[site]", "featured");
  if (featured !== null) {
    const f = flights.find((x) => x.flight_id === featured);
    if (!f) fail("[site].featured", `"${featured}" is not the flight_id of any [[flights]] entry`);
    if (f.active === false && f.status !== "closed") {
      fail("[site].featured", `${featured} has active = false, so it is not on the site`);
    }
  }

  return {
    site: {
      callsign: site.callsign.trim().toUpperCase(),
      featured,
      url: optionalText(site, "[site]", "url") ?? env.SITE_URL ?? vercelUrl,
      repo: optionalText(site, "[site]", "repo") ?? vercelRepo ?? UPSTREAM_REPO,
    },
    flights,
  };
}

const loaded = load();

export const siteConfig: SiteConfig = loaded.site;

/** Every flight in the file, in file order, active or not. */
export const configuredFlights: FlightMeta[] = loaded.flights;
