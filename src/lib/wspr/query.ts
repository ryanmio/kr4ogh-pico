/** Query wspr.live for raw WSPR spot rows, from the browser.
 *
 * A port of tool/picolog/wsprlive.py. wspr.live sends
 * `access-control-allow-origin: *`, so the page can call it directly with no
 * server in between.
 *
 * Endpoint and constraints from https://wspr.live/:
 *   - ClickHouse HTTP interface at https://db1.wspr.live/, GET with ?query=
 *     only (POST is not accepted)
 *   - database `wspr`, spot table `rx`
 *   - "every query you take should limit the data you request by time and band"
 *   - rate limit of 20 requests per minute
 *
 * wspr.live is a free community service run by one person. Every query here is
 * bounded in time, filtered by band, and kept as narrow as the job allows. The
 * page issues two queries per refresh and refreshes on a timer measured in
 * minutes, which sits far inside that budget.
 */

export const ENDPOINT = "https://db1.wspr.live/";

/** wspr.live band codes: first digits of the frequency. */
export const BAND_CODES: Record<string, number> = { "20m": 14 };

/** Refuse windows that would sweep months of data in one request. */
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

/** The columns of wspr.rx this code reads. Narrower than the Python's full
 * column list: the browser only needs what feeds matching and display, and a
 * narrower select is a smaller response over a phone connection. */
export interface Spot {
  id: string;
  time: string; // "YYYY-MM-DD HH:MM:SS", naive UTC
  rx_sign: string;
  tx_sign: string;
  tx_loc: string;
  frequency: number;
  power: number;
}

const SPOT_COLUMNS = "id, time, rx_sign, tx_sign, tx_loc, frequency, power";

/** wspr.live stores naive UTC timestamps; format with the same convention. */
export function wsprTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function timeBounds(windowStart: Date, windowEnd: Date): string {
  if (windowEnd <= windowStart) {
    throw new Error(`empty window: ${wsprTime(windowStart)} .. ${wsprTime(windowEnd)}`);
  }
  if (windowEnd.getTime() - windowStart.getTime() > MAX_WINDOW_MS) {
    throw new Error(`window longer than 31 days: ${wsprTime(windowStart)} .. ${wsprTime(windowEnd)}`);
  }
  return `time >= '${wsprTime(windowStart)}' AND time < '${wsprTime(windowEnd)}'`;
}

/** Regular Type 1 spots by transmitter callsign, in the channel's start
 * minute. The same callsign can fly several channels at once (F1A and F1B
 * share KR4OGH), so the minute is what separates them; without it a second
 * flight's Regular messages would be offered to this flight's matcher.
 * tool/picolog/pipeline.py applies the same restriction when reading back
 * from the store. */
export function regularSpotsQuery(
  callsign: string, band: number, startMinute: number,
  windowStart: Date, windowEnd: Date,
): string {
  if (![0, 2, 4, 6, 8].includes(startMinute)) {
    throw new Error(`start minute must be even: ${startMinute}`);
  }
  return `SELECT ${SPOT_COLUMNS} FROM wspr.rx `
    + `WHERE ${timeBounds(windowStart, windowEnd)} `
    + `AND band = ${Math.trunc(band)} `
    + `AND tx_sign = '${callsign.trim().toUpperCase()}' `
    + `AND toMinute(time) % 10 = ${Math.trunc(startMinute)}`;
}

/** Telemetry candidate spots: 6-char callsigns carrying the given id13 in
 * characters 1 and 3, in the channel's telemetry minute. No frequency filter:
 * receiver calibration error is handled by the matcher, not by the SQL. */
export function telemetryCandidatesQuery(
  id13: string, band: number, telemetryMinute: number,
  windowStart: Date, windowEnd: Date,
): string {
  if (id13.length !== 2 || !"01Q".includes(id13[0]) || !(id13[1] >= "0" && id13[1] <= "9")) {
    throw new Error(`malformed id13: ${id13}`);
  }
  if (![0, 2, 4, 6, 8].includes(telemetryMinute)) {
    throw new Error(`telemetry minute must be even: ${telemetryMinute}`);
  }
  return `SELECT ${SPOT_COLUMNS} FROM wspr.rx `
    + `WHERE ${timeBounds(windowStart, windowEnd)} `
    + `AND band = ${Math.trunc(band)} `
    + `AND substring(tx_sign, 1, 1) = '${id13[0]}' `
    + `AND substring(tx_sign, 3, 1) = '${id13[1]}' `
    + `AND length(tx_sign) = 6 `
    + `AND toMinute(time) % 10 = ${Math.trunc(telemetryMinute)}`;
}

/** Run a query against wspr.live and return raw rows. */
export async function fetchSpots(query: string, signal?: AbortSignal): Promise<Spot[]> {
  const url = `${ENDPOINT}?query=${encodeURIComponent(query + " FORMAT JSON")}`;
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`wspr.live responded ${resp.status}`);
  const body = (await resp.json()) as { data: Spot[] };
  return body.data;
}
