/** HTML string builders shared by build-time rendering and the browser, so a
 * flight looks the same whether its numbers came from the committed track or
 * from a live wspr.live query. */

import {
  bearingDeg, compassPoint, fmtDuration, fmtInt, fmtRelative, fmtUtc, haversineKm,
  trackStats,
} from "./format";
import { METRICS, type MetricKey } from "./metrics";
import type { FlightMeta } from "./types";
import * as u from "./units";
import type { Units } from "./units";
import type { TrackPoint } from "./types";

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function statCard(label: string, value: string, sub: string): string {
  return `<div class="stat">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value">${esc(value)}</div>
    <div class="stat-sub">${esc(sub)}</div>
  </div>`;
}

/** The stat strip under the map.
 *
 * Eight cards, so the grid divides evenly at every breakpoint instead of
 * leaving an orphan on its own row. Labels are written for someone who has
 * never heard of WSPR: "distance covered", not "track"; "battery", not
 * "volts". Position is deliberately absent -- the map above says where it is
 * far better than a grid square does.
 *
 * `live` switches "last heard" to relative time, which only makes sense
 * while a flight is still flying.
 */
export function statsHtml(
  track: TrackPoint[], live: boolean, units: Units = "metric",
): string {
  const s = trackStats(track);
  if (!s) {
    return '<p class="empty-note">No decoded telemetry yet.</p>';
  }
  const volts = track.map((p) => p.voltage_v);
  const temps = track.map((p) => p.temperature_c);
  const alt = (m: number) => u.altitude(m, units).text;
  const spd = (kt: number) => u.speed(kt, units).text;
  const tmp = (c: number) => u.temperature(c, units).text;

  // Heading over the last leg. One fix is not a direction, so it stays blank
  // rather than inventing one.
  const prev = track.length >= 2 ? track[track.length - 2]! : null;
  const heading = prev
    ? bearingDeg(prev.lat, prev.lon, s.last.lat, s.last.lon)
    : null;

  const aloftMs = Date.parse(s.lastUtc) - Date.parse(s.firstUtc);
  const fromLaunchKm = haversineKm(
    track[0]!.lat, track[0]!.lon, s.last.lat, s.last.lon);

  const cards = [
    statCard(
      "Last heard",
      live ? fmtRelative(s.lastUtc) : fmtUtc(s.lastUtc),
      live ? `${s.lastUtc.slice(11, 16)} UTC` : `first ${fmtUtc(s.firstUtc)}`,
    ),
    statCard(
      "Time in the air",
      fmtDuration(aloftMs),
      `since ${s.firstUtc.slice(11, 16)} UTC`,
    ),
    statCard("Altitude", alt(s.last.altitude_m), `highest ${alt(s.maxAltitudeM)}`),
    statCard("Ground speed", spd(s.last.speed_kt), `fastest ${spd(s.maxSpeedKt)}`),
    statCard(
      "Heading",
      heading === null ? "--" : compassPoint(heading),
      heading === null ? "needs two fixes" : `${Math.round(heading)}\u00b0 from north`,
    ),
    statCard(
      "Distance flown",
      u.distance(s.distanceKm, units).text,
      `${u.distance(fromLaunchKm, units).text} from launch`,
    ),
    statCard(
      "Battery",
      `${s.last.voltage_v.toFixed(2)} V`,
      `${Math.min(...volts).toFixed(2)}-${Math.max(...volts).toFixed(2)} V`,
    ),
    statCard(
      "Tracker temp",
      tmp(s.last.temperature_c),
      `${u.temperature(Math.min(...temps), units).value} to ${tmp(Math.max(...temps))}`,
    ),
  ];
  return `<div class="stats">${cards.join("")}</div>`;
}


// ---------- live sidebar ----------

/** Small stroke icons, inline so archived pages keep rendering with no
 * runtime dependencies. Colored via currentColor from the metric. */
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

/** Which card is lit: a metric card, the tracker or status card, or none. */
export type ActiveCard = MetricKey | "tracker" | "status" | null;

const TRACKER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 2.5a6 6 0 0 1 6 6c0 3.7-2.7 6.7-6 6.7s-6-3-6-6.7a6 6 0 0 1 6-6z"/>' +
  '<path d="M10.8 15l-.8 2.5h4l-.8-2.5"/><path d="M12 17.5V21"/></svg>';

function metricCard(
  key: MetricKey, value: string, sub: string, active: ActiveCard,
): string {
  const m = METRICS[key];
  return `<button type="button" class="fv-card" data-metric="${key}"
    aria-pressed="${key === active}">
    <span class="fv-card-icon" style="color:${m.color}">${ICONS[key]}</span>
    <span class="fv-card-text">
      <span class="fv-card-label">${esc(m.label)}</span>
      <span class="fv-card-value">${esc(value)}</span>
      <span class="fv-card-sub">${esc(sub)}</span>
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
 * the reader asks. The map's coloring is named by its own legend. */
export function sidebarHtml(
  meta: FlightMeta, track: TrackPoint[], units: Units, active: ActiveCard,
): string {
  // The tracker card leads: it is what the header used to say (who this
  // is), shaped like every other card, and pressing it opens the build
  // details panel.
  const tracker = `<button type="button" class="fv-card fv-card-wide"
    data-panel="tracker" aria-pressed="${active === "tracker"}">
    <span class="fv-card-icon" style="color:#e2e8f0">${TRACKER_ICON}</span>
    <span class="fv-card-text">
      <span class="fv-card-label">Tracker</span>
      <span class="fv-card-value">${esc(meta.callsign)} · ${esc(meta.flight_id)}</span>
      <span class="fv-card-sub">${esc(meta.band)} ch ${meta.channel}${
        meta.launch_utc ? " · up since " + esc(meta.launch_utc.slice(5, 10)) : ""}</span>
    </span>
    <span class="fv-card-chevron" aria-hidden="true">&rsaquo;</span>
  </button>`;
  const s = trackStats(track);
  if (!s) {
    return tracker + `<div class="fv-status"><p class="empty-note">No decoded
      telemetry yet. The tracker reports every 10 minutes once it has sun
      and a GPS fix.</p></div>`;
  }
  const volts = track.map((p) => p.voltage_v);
  const temps = track.map((p) => p.temperature_c);
  const alt = (m: number) => u.altitude(m, units).text;
  const spd = (kt: number) => u.speed(kt, units).text;
  const tmp = (c: number) => u.temperature(c, units).text;

  // Heading over the last leg. One fix is not a direction, so it stays blank
  // rather than inventing one.
  const prev = track.length >= 2 ? track[track.length - 2]! : null;
  const heading = prev
    ? bearingDeg(prev.lat, prev.lon, s.last.lat, s.last.lon)
    : null;
  const aloftMs = Date.parse(s.lastUtc) - Date.parse(s.firstUtc);
  const fromLaunchKm = haversineKm(
    track[0]!.lat, track[0]!.lon, s.last.lat, s.last.lon);

  const status = `<button type="button" class="fv-status" data-panel="status"
    aria-pressed="${active === "status"}">
    <span class="fv-status-text">
      <span class="fv-status-main">Last heard ${esc(fmtRelative(s.lastUtc))}</span>
      <span class="fv-status-sub">flying for ${esc(fmtDuration(aloftMs))}
        · ${fmtInt(s.points)} reports</span>
    </span>
    <span class="fv-card-chevron" aria-hidden="true">&rsaquo;</span>
  </button>
  <p class="fv-hint">Tap a stat to color the map by it and see its chart</p>`;

  const cards = [
    metricCard(
      "journey",
      u.distance(s.distanceKm, units).text,
      heading === null
        ? "flown so far"
        : `${compassPoint(heading)} · ${u.distance(fromLaunchKm, units).text} from launch`,
      active,
    ),
    metricCard("altitude", alt(s.last.altitude_m), `peak ${alt(s.maxAltitudeM)}`, active),
    metricCard("speed", spd(s.last.speed_kt), `fastest ${spd(s.maxSpeedKt)}`, active),
    metricCard(
      "voltage",
      `${s.last.voltage_v.toFixed(2)} V`,
      `${Math.min(...volts).toFixed(2)}\u2013${Math.max(...volts).toFixed(2)} V seen`,
      active,
    ),
    metricCard(
      "temperature",
      tmp(s.last.temperature_c),
      `${u.temperature(Math.min(...temps), units).value} to ${tmp(Math.max(...temps))}`,
      active,
    ),
    metricCard(
      "receivers",
      fmtInt(s.last.rx_station_count),
      "stations heard the last report",
      active,
    ),
  ];
  return tracker + status + cards.join("");
}

/** Telemetry table, newest first. Long flights are capped so a two-month
 * archive page stays a reasonable download; the full track is always in the
 * flight's JSON. */
export function tableHtml(track: TrackPoint[], maxRows = 500): string {
  if (track.length === 0) return "";
  const capped = track.length > maxRows;
  const rows = [...track].reverse().slice(0, maxRows).map((p) => `<tr>
    <td class="mono">${esc(fmtUtc(p.utc))}</td>
    <td class="mono">${esc(p.grid6)}</td>
    <td class="mono num">${p.lat.toFixed(4)}</td>
    <td class="mono num">${p.lon.toFixed(4)}</td>
    <td class="mono num">${fmtInt(p.altitude_m)}</td>
    <td class="mono num">${p.speed_kt}</td>
    <td class="mono num">${p.voltage_v.toFixed(2)}</td>
    <td class="mono num">${p.temperature_c}</td>
    <td class="mono num">${p.rx_station_count}</td>
  </tr>`);
  const label = capped
    ? `Telemetry table · latest ${fmtInt(maxRows)} of ${fmtInt(track.length)}` +
      " records (full track in the JSON download)"
    : `Telemetry table · ${fmtInt(track.length)} records`;
  return `<details class="telemetry-table">
    <summary>${label}</summary>
    <div class="table-scroll"><table>
      <thead><tr>
        <th>UTC</th><th>Grid</th><th>Lat</th><th>Lon</th>
        <th>Alt (m)</th><th>Speed (kt)</th><th>Volts</th>
        <th>Die temp (°C)</th><th>RX stations</th>
      </tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table></div>
  </details>`;
}

export function outcomeBadgeClass(outcome: string): string {
  return {
    Pass: "badge-pass",
    Fail: "badge-fail",
    Wounded: "badge-wounded",
    Closed: "badge-closed",
    Sample: "badge-sample",
  }[outcome] ?? "badge-closed";
}

/** A flight card for the home page. Used at build time for archived flights
 * and in the browser for live ones. */
