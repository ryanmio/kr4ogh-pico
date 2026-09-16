/** A tap on your phone when the balloon is heard: a Cloudflare Worker.
 *
 * The site has no server, and this keeps it that way: nothing here is in
 * the serving path, and an instance without it is complete. It is an
 * optional extra for the operator. Every five minutes Cloudflare wakes it;
 * it asks wspr.live for each live flight's newest spots, decodes them with
 * the site's own decoder (src/lib/wspr/), and sends a push notification
 * when a flight is heard again after being quiet: the first spot after
 * launch, the first of the morning, landfall after a night over the sea.
 * README.md, "Alerts on your phone", is the walkthrough.
 *
 * Why a Worker and not the daily GitHub Action: a cron here fires on the
 * minute. GitHub's runs late by tens of minutes at busy hours, which is
 * fine for refreshing a track and useless for a wrist-tap.
 *
 * Settings (wrangler.toml [vars], or the Cloudflare dashboard):
 *   SITE_URL       the deployed site: /flights.json there is the flight
 *                  list, and notifications link to /live/<id>/ on it
 *   QUIET_HOURS    how long a flight must have gone unheard for its next
 *                  hearing to count; "0" reports every hearing
 *   NTFY_PRIORITY  optional, 1 (silent) to 5 (urgent); ntfy's default is 3
 * Secrets (`npx wrangler secret put NAME`, or the dashboard):
 *   NTFY_TOPIC     an ntfy topic. Anyone who knows it can subscribe, so
 *                  pick one nobody would guess
 *   NTFY_TOKEN     optional, an access token from an ntfy.sh account.
 *                  ntfy.sh rate-limits anonymous publishing per IP address,
 *                  and Cloudflare's outgoing addresses are shared with every
 *                  other Worker, so the limit is shared too; a token makes
 *                  the limit yours alone
 *   NTFY_SERVER    optional, a self-hosted ntfy in place of https://ntfy.sh
 *   PUSHOVER_TOKEN, PUSHOVER_USER   the same messages through Pushover
 * Either service, or both, may be set.
 *
 * State is one KV key: per flight, the newest hearing already accounted
 * for, so a spot is never reported twice, plus what was last sent, for the
 * status page at the Worker's address.
 */
import { parseUtc } from "../src/lib/format";
import type { FlightMeta } from "../src/lib/types";
import { fetchWindow } from "../src/lib/wspr/track";

export interface Env {
  STATE: KVNamespace;
  SITE_URL: string;
  QUIET_HOURS?: string;
  NTFY_TOPIC?: string;
  NTFY_TOKEN?: string;
  NTFY_SERVER?: string;
  NTFY_PRIORITY?: string;
  PUSHOVER_TOKEN?: string;
  PUSHOVER_USER?: string;
}

/** A slot the tracker was heard in: a full fix, or a ghost (the Regular
 * message alone, so a 4-character grid square and nothing else). */
interface Hearing {
  utc: string;
  grid: string;
  altitude_m: number | null;
  rx_station_count: number;
}

interface FlightState {
  /** Newest hearing accounted for, in the decoder's "YYYY-MM-DD HH:MM:SS"
   * form; null while a watched flight has never been heard. */
  last_heard: string | null;
  last_notified: string | null;
  last_message: string | null;
}

interface State {
  flights: Record<string, FlightState>;
  last_run: string | null;
  last_error: string | null;
}

interface Message {
  title: string;
  body: string;
  url: string;
}

const STATE_KEY = "state";

/** How far back to look the first time a flight is seen. Enough to say when
 * it was last heard in the "Watching" message; bounded because wspr.live
 * asks that every query be. */
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

/** Re-read a little before the last hearing, as the site does
 * (src/lib/livetrack.ts): a fix only decodes once both of its spots have
 * been reported, and the slower stations report late. */
const OVERLAP_MS = 20 * 60 * 1000;

function wsprTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function quietHours(env: Env): number {
  const h = Number(env.QUIET_HOURS ?? "6");
  if (!Number.isFinite(h) || h < 0) {
    throw new Error(`QUIET_HOURS must be a number of hours, 0 or more, not "${env.QUIET_HOURS}"`);
  }
  return h;
}

async function loadFlights(env: Env): Promise<FlightMeta[]> {
  if (!env.SITE_URL) throw new Error("SITE_URL is not set (notify/wrangler.toml)");
  const url = `${env.SITE_URL.replace(/\/+$/, "")}/flights.json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url} responded ${resp.status}`);
  const body = (await resp.json()) as { flights?: FlightMeta[] };
  if (!Array.isArray(body.flights)) throw new Error(`${url} is not the site's flight list`);
  return body.flights;
}

/** The flights worth listening for: up, live, and not past their end. */
function watched(flights: FlightMeta[], now: Date): FlightMeta[] {
  return flights.filter((f) =>
    f.active !== false && f.status === "live"
    && (!f.end_utc || parseUtc(f.end_utc) > now));
}

/** Every hearing newer than `since`, oldest first. Full fixes and ghosts
 * alike: "heard" is the Regular message, whatever else got through. */
async function hearingsSince(
  flight: FlightMeta, since: string | null, now: Date,
): Promise<Hearing[]> {
  const floor = now.getTime() - LOOKBACK_MS;
  let fromMs = since ? Math.max(parseUtc(since).getTime() - OVERLAP_MS, floor) : floor;
  // A minute into the future costs nothing and forgives clock skew.
  let toMs = now.getTime() + 60_000;
  if (flight.launch_utc) fromMs = Math.max(fromMs, parseUtc(flight.launch_utc).getTime());
  if (flight.end_utc) toMs = Math.min(toMs, parseUtc(flight.end_utc).getTime());
  if (toMs <= fromMs) return [];

  const { track, ghosts } = await fetchWindow(flight, new Date(fromMs), new Date(toMs));
  const all: Hearing[] = [
    ...track.map((p) => ({
      utc: p.utc, grid: p.grid6, altitude_m: p.altitude_m, rx_station_count: p.rx_station_count,
    })),
    ...ghosts.map((g) => ({
      utc: g.utc, grid: g.grid4, altitude_m: null, rx_station_count: g.rx_station_count,
    })),
  ];
  return all
    .filter((h) => since === null || h.utc > since)
    .sort((a, b) => a.utc.localeCompare(b.utc));
}

const HOUR_MS = 60 * 60 * 1000;

/** "14:34 UTC" today, "6 Sep 14:44 UTC" on any other day. */
function fmtWhen(utc: string, now: Date): string {
  const d = parseUtc(utc);
  const clock = d.toISOString().slice(11, 16) + " UTC";
  if (d.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) return clock;
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${d.getUTCDate()} ${month} ${clock}`;
}

function fmtSpan(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

function describe(h: Hearing): string {
  // A ghost has a 4-character grid and no altitude; that says itself.
  const where = h.altitude_m === null
    ? h.grid
    : `${h.grid}, ${h.altitude_m.toLocaleString("en-US")} m`;
  const n = h.rx_station_count;
  return `${where}, heard by ${n} station${n === 1 ? "" : "s"}`;
}

function rule(env: Env): string {
  const h = quietHours(env);
  return h === 0 ? "every hearing" : `the next hearing after ${h} h of silence`;
}

function liveUrl(env: Env, flight: FlightMeta): string {
  return `${env.SITE_URL.replace(/\/+$/, "")}/live/${flight.flight_id}/`;
}

/** Sent once, the first time the Worker sees a flight. It says what it will
 * do, and by arriving it proves the whole path works. */
function watchingMessage(env: Env, flight: FlightMeta, newest: Hearing | null, now: Date): Message {
  const heard = newest
    ? `Last heard ${fmtWhen(newest.utc, now)}, ${fmtSpan(now.getTime() - parseUtc(newest.utc).getTime())} ago: ${describe(newest)}.`
    : `Not heard in the last ${Math.round(LOOKBACK_MS / 86_400_000)} days.`;
  return {
    title: `Watching ${flight.callsign} ${flight.flight_id}`,
    body: `${heard} You will hear about ${rule(env)}.`,
    url: liveUrl(env, flight),
  };
}

/** The most recent hearing that followed at least `quietMs` of silence,
 * the silence before the first counted from `since`: its index, and the
 * silence. A tick normally holds one new hearing, so this is "the one";
 * after a lapse (a Cloudflare outage, a send that kept failing) it holds a
 * day, and then the resumption worth reporting is the last, not the first.
 * A flight never heard before resumes with its first hearing. */
function resumedAt(
  hearings: Hearing[], since: string | null, quietMs: number,
): { index: number; silenceMs: number } | null {
  let found: { index: number; silenceMs: number } | null = null;
  let prevMs = since === null ? -Infinity : parseUtc(since).getTime();
  hearings.forEach((h, index) => {
    const ms = parseUtc(h.utc).getTime();
    if (ms - prevMs >= quietMs) found = { index, silenceMs: ms - prevMs };
    prevMs = ms;
  });
  return found;
}

function heardMessage(
  env: Env, flight: FlightMeta, hearings: Hearing[], resumed: { index: number; silenceMs: number },
  now: Date,
): Message {
  const at = hearings[resumed.index];
  const newest = hearings[hearings.length - 1];
  const when = !Number.isFinite(resumed.silenceMs)
    ? `First heard ${fmtWhen(at.utc, now)}.`
    : resumed.silenceMs >= HOUR_MS
      ? `Heard ${fmtWhen(at.utc, now)}, after ${fmtSpan(resumed.silenceMs)} of silence.`
      : `Heard ${fmtWhen(at.utc, now)}.`;
  const latest = newest !== at ? `Latest ${fmtWhen(newest.utc, now)}: ` : "";
  return {
    title: `${flight.callsign} ${flight.flight_id} heard`,
    body: `${when} ${latest}${describe(newest)}.`,
    url: liveUrl(env, flight),
  };
}

/** POST once; on 429 (rate limited) wait and try again, a few times. A
 * shared-address limit is a burst limit, and a pause is usually enough.
 * Anything else that is not 2xx is reported with the service's own words. */
async function post(service: string, url: string, init: RequestInit): Promise<void> {
  const pauses = [4_000, 8_000, 12_000];
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, init);
    if (resp.ok) return;
    const detail = (await resp.text()).replace(/\s+/g, " ").trim().slice(0, 160);
    if (resp.status === 429 && attempt < pauses.length) {
      await new Promise((r) => setTimeout(r, pauses[attempt]));
      continue;
    }
    throw new Error(`${service} responded ${resp.status}${detail ? `: ${detail}` : ""}`);
  }
}

async function push(env: Env, msg: Message): Promise<void> {
  const sends: Promise<void>[] = [];
  if (env.NTFY_TOPIC) {
    // JSON publishing rather than headers: a title with a non-ASCII
    // character in a header needs escaping, and a body does not.
    sends.push(post("ntfy", env.NTFY_SERVER ?? "https://ntfy.sh", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.NTFY_TOKEN ? { authorization: `Bearer ${env.NTFY_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        topic: env.NTFY_TOPIC,
        title: msg.title,
        message: msg.body,
        click: msg.url,
        tags: ["balloon"],
        priority: Number(env.NTFY_PRIORITY ?? 3),
      }),
    }));
  }
  if (env.PUSHOVER_TOKEN && env.PUSHOVER_USER) {
    sends.push(post("Pushover", "https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: env.PUSHOVER_TOKEN,
        user: env.PUSHOVER_USER,
        title: msg.title,
        message: msg.body,
        url: msg.url,
        url_title: "Open the map",
      }),
    }));
  }
  if (sends.length === 0) {
    throw new Error(
      "nowhere to send: set the NTFY_TOPIC secret, or PUSHOVER_TOKEN and PUSHOVER_USER"
      + ' (README.md, "Alerts on your phone")',
    );
  }
  const failed = (await Promise.allSettled(sends))
    .map((r) => (r.status === "rejected" ? String(r.reason instanceof Error ? r.reason.message : r.reason) : null))
    .filter((x): x is string => x !== null);
  if (failed.length) throw new Error(failed.join("; "));
}

async function readState(env: Env): Promise<State> {
  const saved = (await env.STATE.get(STATE_KEY, "json")) as State | null;
  return saved ?? { flights: {}, last_run: null, last_error: null };
}

/** One tick. State is written whatever happens, so the status page always
 * shows the last run and its error if it had one; a flight's own entry
 * only advances once its message, if any, has been sent, so a failed send
 * is retried on the next tick rather than lost. */
export async function run(env: Env, now: Date = new Date()): Promise<State> {
  const state = await readState(env);
  const quietMs = quietHours(env) * HOUR_MS;
  try {
    const flights = watched(await loadFlights(env), now);
    // A flight that has left the list is forgotten, so that if it ever
    // comes back it starts with a "Watching" message like a new one.
    for (const id of Object.keys(state.flights)) {
      if (!flights.some((f) => f.flight_id === id)) delete state.flights[id];
    }

    for (const flight of flights) {
      const prev = state.flights[flight.flight_id] ?? null;
      const since = prev?.last_heard ?? null;
      const hearings = await hearingsSince(flight, since, now);
      const newest = hearings[hearings.length - 1] ?? null;

      let msg: Message | null = null;
      if (prev === null) {
        msg = watchingMessage(env, flight, newest, now);
      } else if (newest !== null) {
        const resumed = resumedAt(hearings, since, quietMs);
        if (resumed) msg = heardMessage(env, flight, hearings, resumed, now);
      }
      if (msg) await push(env, msg);

      state.flights[flight.flight_id] = {
        last_heard: newest?.utc ?? since,
        last_notified: msg ? wsprTime(now) : prev?.last_notified ?? null,
        last_message: msg ? `${msg.title}: ${msg.body}` : prev?.last_message ?? null,
      };
    }
    state.last_error = null;
  } catch (err) {
    state.last_error = `${wsprTime(now)}: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  } finally {
    state.last_run = wsprTime(now);
    await env.STATE.put(STATE_KEY, JSON.stringify(state));
  }
  return state;
}

export default {
  async scheduled(_event, env) {
    await run(env);
  },

  /** The status page: settings that are safe to show, and the state. */
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/") return new Response("not found", { status: 404 });
    const state = await readState(env);
    return Response.json({
      site: env.SITE_URL,
      quiet_hours: env.QUIET_HOURS ?? "6",
      sends_to: {
        ntfy: Boolean(env.NTFY_TOPIC),
        pushover: Boolean(env.PUSHOVER_TOKEN && env.PUSHOVER_USER),
      },
      ...state,
    });
  },
} satisfies ExportedHandler<Env>;
