/** HTML string builders shared by build-time rendering and the browser, so a
 * flight looks the same whether its numbers came from the committed track or
 * from a live wspr.live query. */

import {
  fmtDuration, fmtInt, fmtLocal, fmtLocalDay, fmtRelative, fmtUtc,
  haversineKm, isInferred, parseUtc, trackStats,
} from "./format";
import { heardBounds, waypoints } from "./ghosts";
import { METRICS, type MetricKey } from "./metrics";
import { RECORDS, type FlightSummary, type Holders, type RecordKey } from "./records";
import {
  groundSpeedKt, hasSaturatedSpeed, isSpeedFloor, speedText, SPEED_CEILING_KT,
} from "./speed";
import { fmtSun, sunAt } from "./sun";
import type { FlightMeta, GhostPoint } from "./types";
import * as u from "./units";
import type { Units } from "./units";
import type { TrackPoint } from "./types";
import { wakeCutoff } from "./wake";

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

// ---------- live sidebar ----------

/** Small stroke icons, inline so the page needs no icon font or sprite. Colored via currentColor from the metric. */
const ICONS: Record<MetricKey, string> = {
  journey:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="9"/>' +
    '<path d="M15.5 8.5l-2.2 4.8-4.8 2.2 2.2-4.8z" fill="currentColor" stroke="none"/></svg>',
  altitude:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 18l6-11 4 7 3-4 5 8z"/></svg>',
  speed:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M5 17.5a8 8 0 1 1 14 0"/><path d="M12 14l4.5-4.5"/></svg>',
  voltage:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M13 2.5L5 13.5h5.5L11 21.5l8-11h-5.5z"/></svg>',
  sun:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 18h18"/><path d="M7 18a5 5 0 0 1 10 0"/>' +
    '<path d="M12 6v2.5M4.6 10.6l1.8 1.8M19.4 10.6l-1.8 1.8"/></svg>',
  temperature:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M10 4a2 2 0 0 1 4 0v9.3a4 4 0 1 1-4 0z"/><path d="M12 9v6"/></svg>',
  receivers:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="9.5" r="1.7" fill="currentColor" stroke="none"/>' +
    '<path d="M12 11.5V20"/>' +
    '<path d="M8.7 12.8a4.6 4.6 0 0 1 0-6.6M15.3 6.2a4.6 4.6 0 0 1 0 6.6"/>' +
    '<path d="M6.2 15.3a8 8 0 0 1 0-11.6M17.8 3.7a8 8 0 0 1 0 11.6"/></svg>',
};

/** Which card is lit: a metric card, the tracker, status or records card,
 * or none. */
export type ActiveCard = MetricKey | "tracker" | "status" | "records" | null;

const TRACKER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 2.5a6 6 0 0 1 6 6c0 3.7-2.7 6.7-6 6.7s-6-3-6-6.7a6 6 0 0 1 6-6z"/>' +
  '<path d="M10.8 15l-.8 2.5h4l-.8-2.5"/><path d="M12 17.5V21"/></svg>';

/** What a tooltip, the table and the map key call an inferred fix's
 * pairing, and the shorter word a card's label has room for. */
export const INFERRED_LABEL = "cross-receiver";
export const INFERRED_TAG = "inferred";
export const INFERRED_TITLE =
  "From a telemetry fix heard by a different station from the one that "
  + "heard the balloon's callsign message (cross-receiver pairing). "
  + "Accepted only when it is the one message in its slot that fits the "
  + "flight; less certain than a fix one station heard whole.";

/** `inferred` marks a value read off an inferred fix: the label says so,
 * and its tooltip says what that means. `subShort` is the sub line for a
 * phone, where a card is half the width and the long form would be cut. */
function metricCard(
  key: MetricKey, value: string, sub: string, active: ActiveCard, inferred = false,
  subShort?: string,
): string {
  const m = METRICS[key];
  const tier = inferred
    ? ` <span class="fv-card-tier" title="${esc(INFERRED_TITLE)}">· ${INFERRED_TAG}</span>`
    : "";
  return `<button type="button" class="fv-card" data-metric="${key}"
    aria-pressed="${key === active}">
    <span class="fv-card-icon" style="color:${m.color}">${ICONS[key]}</span>
    <span class="fv-card-text">
      <span class="fv-card-label">${esc(m.label)}${tier}</span>
      <span class="fv-card-value">${esc(value)}</span>
      <span class="fv-card-sub">${subShort === undefined ? esc(sub)
        : `<span class="fv-card-lead">${esc(sub)}</span><span
          class="fv-card-short">${esc(subShort)}</span>`}</span>
    </span>
    <span class="fv-card-chevron" aria-hidden="true">&rsaquo;</span>
  </button>`;
}

/** The stat cards beside (or, on a phone, below) the live map. Each one is a
 * button: pressing it colors the map's spots by that metric and opens the
 * detail panel. Rendered at build time so the numbers are on screen at first
 * paint, and re-rendered in the browser on refresh and unit changes. */
/** `active` is the card whose panel is open, or null when none is: the
 * highlight means "details shown below", so nothing is highlighted until
 * the reader asks. The map's coloring is named by its own legend.
 *
 * `ghosts` are the slots heard without telemetry. They count as the
 * tracker being heard -- "last heard" and "flying 13d" take them in -- and
 * as nothing else: every number on the metric cards is from the last full
 * fix, because a ghost carries none of them. That fix may be an inferred
 * one (docs/cross-receiver-pairing.md), and then its cards say so; the
 * peak and the fastest are from confirmed fixes only. */
export function sidebarHtml(
  meta: FlightMeta, track: TrackPoint[], units: Units, active: ActiveCard,
  opts: {
    pending?: boolean; ghosts?: GhostPoint[]; spoofed?: TrackPoint[];
    records?: RecordsCardInfo;
  } = {},
): string {
  const ended = meta.status === "closed";
  const ghosts = opts.ghosts ?? [];
  const spoofed = opts.spoofed ?? [];
  // Last in the column: it is about every flight, not a reading from this
  // one, and it is there whatever state this flight's own cards are in.
  const records = opts.records ? recordsCard(opts.records, ended, active) : "";
  // The tracker card leads: it is what the header used to say (who this
  // is), shaped like every other card, and pressing it opens the build
  // details panel.
  const when = meta.launch_utc
    ? ended && meta.end_utc
      ? ` · flew ${esc(meta.launch_utc.slice(5, 10))} to ${esc(meta.end_utc.slice(5, 10))}`
      : ` · up since ${esc(meta.launch_utc.slice(5, 10))}`
    : "";
  const tracker = `<button type="button" class="fv-card fv-card-wide"
    data-panel="tracker" aria-pressed="${active === "tracker"}">
    <span class="fv-card-icon" style="color:#e2e8f0">${TRACKER_ICON}</span>
    <span class="fv-card-text">
      <span class="fv-card-label">Tracker</span>
      <span class="fv-card-value">${esc(meta.callsign)} · ${esc(meta.flight_id)}</span>
      <span class="fv-card-sub">${esc(meta.band)} ch ${meta.channel}${when}</span>
    </span>
    <span class="fv-card-chevron" aria-hidden="true">&rsaquo;</span>
  </button>`;
  // The home page switching to another flight: its track is on the way.
  if (opts.pending) {
    return tracker + `<div class="fv-status"><p class="empty-note">Loading the
      track&hellip;</p></div>` + records;
  }
  const s = trackStats(track, waypoints(track, ghosts, opts.spoofed ?? []));
  if (!s) {
    const heard = heardBounds(track, ghosts);
    // Heard, but never with its telemetry: the map has a square to show
    // and the card can say when, and that is all.
    const note = heard
      ? `Heard ${fmtInt(ghosts.length)} time${ghosts.length === 1 ? "" : "s"},
        last ${esc(heard.lastUtc.slice(5, 16))} UTC, but never with its
        telemetry: the position is known to a grid square and nothing else
        yet. The tracker reports every 10 minutes once it has sun and a GPS
        fix.`
      : `No decoded telemetry yet. The tracker reports every 10 minutes once
        it has sun and a GPS fix.`;
    return tracker + `<div class="fv-status"><p class="empty-note">${note}</p></div>` + records;
  }
  // Spoofed fixes count here: the tracker was heard, and "Heard 2 min
  // ago" is true while its GPS is being lied to.
  const heard = heardBounds(track, ghosts, spoofed)!;
  const volts = track.map((p) => p.voltage_v);
  const temps = track.map((p) => p.temperature_c);
  const alt = (m: number) => u.altitude(m, units).text;
  const spd = (kt: number) => u.speed(kt, units).text;
  const tmp = (c: number) => u.temperature(c, units).text;

  const aloftMs = parseUtc(heard.lastUtc).getTime() - parseUtc(heard.firstUtc).getTime();
  const fromLaunchKm = haversineKm(
    track[0]!.lat, track[0]!.lon, s.last.lat, s.last.lon);

  // Shaped like every other card: a label, one line that never wraps, a
  // sub line. A closed flight says only that it ended; the date it was
  // last heard, and whether that newest report was position-only, are in
  // the Signal panel, with the count of reports heard without telemetry.
  // The dot stops pulsing when the flight is over.
  const status = `<button type="button" class="fv-card fv-status" data-panel="status"
    aria-pressed="${active === "status"}">
    <span class="fv-card-icon" style="color:${ended ? "#94a3b8" : "#34d399"}"><span
      class="fv-status-dot${ended ? " fv-status-dot-ended" : ""}"></span></span>
    <span class="fv-card-text">
      <span class="fv-card-label">Signal</span>
      <span class="fv-card-value">${ended
        ? "Flight ended"
        : `Heard ${esc(fmtRelative(heard.lastUtc))}`}</span>
      <span class="fv-card-sub">${ended ? "flew" : "flying"} ${esc(fmtDuration(aloftMs))}
        · ${fmtInt(s.points)} reports</span>
    </span>
    <span class="fv-card-chevron" aria-hidden="true">&rsaquo;</span>
  </button>
  <p class="fv-hint">Tap a stat to color the map by it and see its chart</p>`;

  // The newest fix, read by every card below but Journey, may be inferred.
  const lastInferred = isInferred(s.last);
  // The sun at every report: the card gives the span the tracker has been
  // heard under, which is the span it can work in.
  const suns = track.map(sunAt);
  const sunLo = fmtSun(Math.min(...suns));
  const sunHi = fmtSun(Math.max(...suns));
  const wakeAt = wakeCutoff([...track, ...ghosts]);
  const cards = [
    metricCard(
      "journey",
      u.distance(s.distanceKm, units).text,
      track.length < 2
        ? "flown so far"
        : `${u.distance(fromLaunchKm, units).text} from launch`,
      active,
      false,
      // The distance from launch does not fit a phone's card, and half of
      // it ("5,575 km away") reads as something else; the short line names
      // the big number instead. From launch is in the Journey panel.
      track.length < 2 ? undefined : "traveled",
    ),
    // The short lines drop the unit: the value above them carries it.
    metricCard("altitude", alt(s.last.altitude_m), `peak ${alt(s.maxAltitudeM)}`, active,
      lastInferred, `peak ${fmtInt(u.altitude(s.maxAltitudeM, units).value)}`),
    metricCard("speed", speedText(s.last, units), `fastest ${spd(s.maxSpeedKt)}`, active,
      lastInferred, `fastest ${fmtInt(u.speed(s.maxSpeedKt, units).value)}`),
    metricCard(
      "voltage",
      `${s.last.voltage_v.toFixed(2)} V`,
      `${Math.min(...volts).toFixed(2)}\u2013${Math.max(...volts).toFixed(2)} V seen`,
      active,
      lastInferred,
      `${Math.min(...volts).toFixed(2)}\u2013${Math.max(...volts).toFixed(2)} V`,
    ),
    // Under the range, the angle this tracker has been coming back at,
    // once it has woken from enough nights to say.
    metricCard(
      "sun",
      sunLo === sunHi ? sunHi : `${sunLo.slice(0, -1)}\u2013${sunHi}`,
      wakeAt !== null
        ? `${ended ? "woke" : "wakes"} near ${fmtSun(wakeAt)}`
        : "above the horizon",
      active,
      false,
      wakeAt !== null
        ? `${ended ? "woke" : "wakes"} at ${fmtSun(wakeAt)}`
        : "when heard",
    ),
    metricCard(
      "temperature",
      tmp(s.last.temperature_c),
      `${u.temperature(Math.min(...temps), units).value} to ${tmp(Math.max(...temps))}`,
      active,
      lastInferred,
    ),
    metricCard(
      "receivers",
      fmtInt(s.last.rx_station_count),
      "stations heard the last report",
      active,
      lastInferred,
      "stations",
    ),
  ];
  return tracker + status + cards.join("") + records;
}

/** The speed column, in the reader's units. A fix under the field's ceiling
 * prints what the tracker sent. At the ceiling the tracker only proved a
 * lower bound, so the cell prints either "152+" or the tilde-marked estimate
 * the track measured, never a bare 152 that would read as a measurement. */
function speedCell(p: TrackPoint, units: Units): string {
  const v = (kt: number) => fmtInt(Math.round(u.convert.speed(kt, units)));
  if (!isSpeedFloor(p) && p.speed_kt_est === undefined) return v(p.speed_kt);
  return isSpeedFloor(p) ? `${v(p.speed_kt)}+` : `~${v(groundSpeedKt(p))}`;
}

/** Telemetry table, newest first, in the reader's units. Long flights are
 * capped so a two-month flight stays a reasonable page; the full track is
 * always in the flight's JSON. What the marks in it mean is tableNotes'. */
export function tableHtml(track: TrackPoint[], units: Units, maxRows = TABLE_MAX_ROWS): string {
  if (track.length === 0) return "";
  const lbl = u.unitLabels(units);
  const alt = (m: number) => fmtInt(Math.round(u.convert.altitude(m, units)));
  const tmp = (c: number) => `${Math.round(u.convert.temperature(c, units))}`;
  // The sensor columns exist only on a flight whose tracker has sent a
  // reading (a Petrel's BME280, see lib/wspr/decode.ts): the one place on
  // the page the reading is shown. A fix whose reading was not heard
  // leaves them blank.
  const sensor = track.some((p) => p.pressure_hpa !== undefined);
  const sensorCells = (p: TrackPoint) => sensor
    ? `<td class="mono num">${p.pressure_hpa ?? ""}</td>
    <td class="mono num">${p.board_temp_c === undefined ? "" : tmp(p.board_temp_c)}</td>
    <td class="mono num">${p.humidity_pct ?? ""}</td>`
    : "";
  const sensorHeads = sensor
    ? `<th>hPa</th><th>Board (${lbl.temperature})</th><th>RH (%)</th>` : "";
  const tiers = hasTiers(track);
  const tierCell = (p: TrackPoint) => {
    if (!tiers) return "";
    const what = isInferred(p) ? INFERRED_LABEL
      : p.sensor_tier === "inferred" ? `sensor ${INFERRED_LABEL}` : "";
    const why = p.pairing ?? p.sensor_pairing;
    return `<td class="mono"${why ? ` title="${esc(why)}"` : ""}>${what}</td>`;
  };
  const rows = [...track].reverse().slice(0, maxRows).map((p) => `<tr>
    <td class="mono">${esc(fmtUtc(p.utc))}</td>
    <td class="mono">${esc(p.grid6)}</td>
    <td class="mono num">${p.lat.toFixed(4)}</td>
    <td class="mono num">${p.lon.toFixed(4)}</td>
    <td class="mono num">${alt(p.altitude_m)}</td>
    <td class="mono num">${speedCell(p, units)}</td>
    <td class="mono num">${p.voltage_v.toFixed(2)}</td>
    <td class="mono num">${tmp(p.temperature_c)}</td>
    ${sensorCells(p)}
    <td class="mono num">${p.rx_station_count}</td>
    ${tierCell(p)}
  </tr>`);
  return `<div class="telemetry-table"><div class="table-scroll"><table>
      <thead><tr>
        <th>UTC</th><th>Grid</th><th>Lat</th><th>Lon</th>
        <th>Alt (${lbl.altitude})</th><th>Speed (${lbl.speed})</th><th>Volts</th>
        <th>Die temp (${lbl.temperature})</th>${sensorHeads}<th>RX stations</th>${
  tiers ? "<th>Pairing</th>" : ""}
      </tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table></div></div>`;
}

export const TABLE_MAX_ROWS = 500;

/** A pairing column, only once an inferred fix or reading is on the track
 * (docs/cross-receiver-pairing.md): every other row is a same-station pair,
 * and the column would say so 400 times. */
function hasTiers(track: TrackPoint[]): boolean {
  return track.some((p) => isInferred(p) || p.sensor_tier === "inferred");
}

/** What the table's marks mean, one paragraph each, for the panel's info
 * button. Each only on a flight where the table actually shows the mark. */
export function tableNotes(track: TrackPoint[], units: Units, maxRows = TABLE_MAX_ROWS): string[] {
  const notes: string[] = [];
  if (track.length > maxRows) {
    notes.push(`The table shows the latest ${fmtInt(maxRows)} of
      ${fmtInt(track.length)} reports; the JSON download has every one.`);
  }
  if (hasSaturatedSpeed(track)) {
    const top = fmtInt(Math.round(u.convert.speed(SPEED_CEILING_KT, units)));
    notes.push(`The speed field stops at ${u.speed(SPEED_CEILING_KT, units).text},
      so "${top}+" is the tracker saying "at least this". A "~" speed is
      measured from the distance flown either side of the report instead.`);
  }
  if (hasTiers(track)) {
    notes.push(`A "${INFERRED_LABEL}" row is a fix whose telemetry was heard
      by a different station from the one that heard the callsign message. It
      is kept only when it is the one message in its slot that fits the
      flight's path and altitude. It is drawn as a ring on the map, and sets
      no record.`);
  }
  return notes;
}

// ---------- records ----------

/** What the Records card says: how many flights the records are drawn
 * from, how many records are held at all, and how many of them this
 * flight holds. */
export interface RecordsCardInfo {
  flights: number;
  held: number;
  /** Records with a holder: a crossing nobody has made is not one. */
  total: number;
}

const RECORDS_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M7.5 4h9v4.5a4.5 4.5 0 0 1-9 0z"/>' +
  '<path d="M7.5 6H5.2a1.8 1.8 0 0 0 0 3.6h2.3M16.5 6h2.3a1.8 1.8 0 0 1 0 3.6h-2.3"/>' +
  '<path d="M12 13v3.5"/><path d="M8.5 20h7"/><path d="M10 16.5h4v3.5h-4z"/></svg>';

/** The star on a record's map pin, on both renderers: filled in the
 * records' amber, on the same dark casing as everything else drawn over
 * imagery. */
export const RECORD_PIN_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" stroke="#0b1020" stroke-width="1.5"' +
  ' stroke-linejoin="round"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4' +
  'l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/></svg>';

/** The expected-wake mark on the forecast line (lib/wake.ts): a small sun,
 * the records' pale gold, rays and all, so it reads as "sunrise" without a
 * word. Drawn at 14 px. */
export const WAKE_SUN_SVG =
  '<svg viewBox="0 0 24 24"><g stroke="#fde68a" stroke-width="2.2" stroke-linecap="round">' +
  [0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
    const r = (a * Math.PI) / 180;
    const p = (d: number) => `${(12 + d * Math.cos(r)).toFixed(1)} ${(12 + d * Math.sin(r)).toFixed(1)}`;
    return `<path d="M${p(7.5)}L${p(10.5)}"/>`;
  }).join("") +
  '</g><circle cx="12" cy="12" r="4.5" fill="#fde68a" stroke="#0b1020" stroke-width="1"/></svg>';

/** The records' own colour: a medal's gold, which is neither the track's
 * white, the overlays' grey, the forecast's lavender nor a step on the
 * altitude ramp. */
const RECORD_COLOR = "#fbbf24";

/** The card that opens the records panel. Wide, like the tracker card: it
 * is about every flight, not a reading from this one. */
function recordsCard(info: RecordsCardInfo, ended: boolean, active: ActiveCard): string {
  // On a phone the card is half the width: the verb is dropped there
  // (.fv-card-lead), and "9 of 10" under "Records" still says it.
  const value = info.held
    ? `<span class="fv-card-lead">Holds </span>${info.held} of ${info.total}`
    : ended ? "Held none" : "None yet";
  return `<button type="button" class="fv-card" data-panel="records"
    aria-pressed="${active === "records"}">
    <span class="fv-card-icon" style="color:${RECORD_COLOR}">${RECORDS_ICON}</span>
    <span class="fv-card-text">
      <span class="fv-card-label">Records</span>
      <span class="fv-card-value">${value}</span>
      <span class="fv-card-sub"><span class="fv-card-lead">across </span>${
        info.flights} flights</span>
    </span>
    <span class="fv-card-chevron" aria-hidden="true">&rsaquo;</span>
  </button>`;
}

/** What the records panel is built from. */
export interface RecordsView {
  /** Every flight with telemetry, in launch order. */
  summaries: FlightSummary[];
  holders: Holders;
  /** The flight on screen: named "this flight" rather than linked. */
  current: string;
  units: Units;
  /** The record whose pin the map has been flown to, if any. */
  focus: RecordKey | null;
  /** The address that opens another flight, for the table. */
  hrefFor(flightId: string): string;
}

/** "Oct 24", in the reader's zone. Browser only, like the panel. */
function day(utc: string): string {
  return fmtLocalDay(parseUtc(utc));
}

/** The records panel: a tile per record, naming the flight that holds it
 * and the day it was set, and under them one row per flight with the
 * record cells lit. A flight id means little on its own, so every row
 * carries the dates it flew, and every flight but this one is a link to
 * its page. The crossings share one column, which appears once any flight
 * has made one, so the table does not grow three columns of dashes.
 * Pressing a tile is the caller's affair: the map flies to the record's
 * pin. */
/** A flight's crossings, "Atlantic ≈6d 4h · Halfway round ≈9d 22h", each
 * lit on its own when this flight holds it; a dash for a flight that made
 * none. */
function crossingCell(s: FlightSummary, crossings: typeof RECORDS, v: RecordsView): string {
  const made = crossings.filter((r) => s.values[r.key] !== undefined);
  if (!made.length) return '<td class="mono">—</td>';
  return `<td class="mono">${made.map((r) => {
    const text = esc(`${r.short} ${r.fmt(s.values[r.key]!, v.units, s)}`);
    return v.holders[r.key]?.flight_id === s.flight_id
      ? `<span class="is-record">${text}</span>` : text;
  }).join(" · ")}</td>`;
}

export function recordsHtml(v: RecordsView): string {
  const who = (s: FlightSummary) =>
    s.flight_id === v.current ? '<span class="fv-this">This flight</span>' : esc(s.flight_id);
  const tiles = RECORDS.flatMap((r) => {
    const s = v.holders[r.key];
    if (!s) return [];
    // An estimated crossing says what it was estimated from.
    const between = s.at[r.key]!.between;
    const title = between
      ? `Estimated along the track between the fixes at ${fmtLocal(between[0])}`
        + ` and ${fmtLocal(between[1])}. Show on the map where it was crossed`
      : "Show on the map where it was set";
    return [`<button type="button" class="fv-record" data-record="${r.key}"
      aria-pressed="${v.focus === r.key}" title="${esc(title)}">
      <span class="fv-record-label">${esc(r.label)}</span>
      <b class="fv-record-value">${esc(r.fmt(s.values[r.key]!, v.units, s))}</b>
      <span class="fv-record-who">${who(s)} · ${esc(day(s.at[r.key]!.utc))}</span>
    </button>`];
  });
  const columns = RECORDS.filter((r) => !r.crossing);
  const crossings = RECORDS.filter((r) =>
    r.crossing && v.summaries.some((s) => s.values[r.key] !== undefined));
  const head = columns.map((r) => `<th>${esc(r.label)}</th>`).join("")
    + (crossings.length ? "<th>Crossings</th>" : "");
  const rows = v.summaries.map((s) => {
    const current = s.flight_id === v.current;
    const name = current
      ? `${esc(s.flight_id)} <span class="fv-this">this flight</span>`
      : `<a href="${esc(v.hrefFor(s.flight_id))}">${esc(s.flight_id)}</a>`;
    const flown = s.status === "closed"
      ? `${day(s.firstUtc)} – ${day(s.lastUtc)}`
      : `${day(s.firstUtc)} · still up`;
    const cells = columns.map((r) => {
      const held = v.holders[r.key]?.flight_id === s.flight_id;
      return `<td class="mono num${held ? " is-record" : ""}">` +
        `${esc(r.fmt(s.values[r.key]!, v.units, s))}</td>`;
    }).join("") + (crossings.length ? crossingCell(s, crossings, v) : "");
    return `<tr${current ? ' class="is-current"' : ""}>
      <th scope="row">${name}</th><td class="mono">${esc(flown)}</td>${cells}</tr>`;
  });
  return `<p class="fv-panel-note">Across every flight on this site. Press a
    record to see where it was set; the map carries every flight's track
    while this panel is open.</p>
    <div class="fv-records">${tiles.join("")}</div>
    <div class="table-scroll"><table class="records-table">
      <thead><tr><th>Flight</th><th>Flown</th>${head}</tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table></div>`;
}
