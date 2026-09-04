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
import type { FlightMeta, SiteConfig } from "./types";

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
  "flight_id", "callsign", "band", "channel", "active", "launch_utc",
  "launch_lat", "launch_lon", "status", "close_reason", "tracker",
]);

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

  const launchUtc = optionalText(entry, where, "launch_utc");
  if (launchUtc !== null) {
    if (!LAUNCH_UTC.test(launchUtc)) {
      fail(`${where}.launch_utc`, 'must look like "2026-08-30 12:44:00" (UTC, in quotes)');
    }
    if (Number.isNaN(Date.parse(launchUtc.replace(" ", "T") + "Z"))) {
      fail(`${where}.launch_utc`, `"${launchUtc}" is not a real date and time`);
    }
  }

  const status = entry.status ?? "live";
  if (status !== "live" && status !== "closed") {
    fail(`${where}.status`, 'must be "live" or "closed"');
  }

  let tracker: Record<string, string> | undefined;
  if (entry.tracker !== undefined) {
    if (!isTable(entry.tracker)) {
      fail(`${where}.tracker`, "must be a table of label = value lines");
    }
    tracker = Object.fromEntries(
      Object.entries(entry.tracker).map(([k, v]) => [k, String(v)]),
    );
  }

  return {
    flight_id: flightId,
    callsign,
    band,
    channel,
    active,
    launch_utc: launchUtc,
    launch_lat: optionalNumber(entry, where, "launch_lat"),
    launch_lon: optionalNumber(entry, where, "launch_lon"),
    status,
    close_reason: optionalText(entry, where, "close_reason"),
    ...(tracker ? { tracker } : {}),
  };
}

function load(): { site: SiteConfig; flights: FlightMeta[] } {
  let text: string;
  try {
    text = readFileSync(CONFIG_URL, "utf8");
  } catch {
    fail("", "not found (expected at the repo root)");
  }
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

  return {
    site: {
      callsign: site.callsign.trim().toUpperCase(),
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
