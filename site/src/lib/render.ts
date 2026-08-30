/** HTML string builders shared by build-time rendering and the browser, so a
 * flight looks the same whether its numbers came from the committed track or
 * from a live wspr.live query. */

import { fmtInt, fmtRelative, fmtUtc, trackStats } from "./format";
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
 * Labels are written for someone who has never heard of WSPR: "distance
 * covered", not "track"; "battery", not "volts". Position is deliberately
 * absent -- the map above says where it is far better than a grid square
 * does. `live` switches "last heard" to relative time, which only makes
 * sense while a flight is still flying.
 */
export function statsHtml(
  track: TrackPoint[], live: boolean, units: Units = "metric",
): string {
  const s = trackStats(track);
  if (!s) {
    return '<p class="empty-note">No decoded telemetry yet.</p>';
  }
  const days = (Date.parse(s.lastUtc) - Date.parse(s.firstUtc)) / 86_400_000;
  const volts = track.map((p) => p.voltage_v);
  const temps = track.map((p) => p.temperature_c);
  const alt = (m: number) => u.altitude(m, units).text;
  const spd = (kt: number) => u.speed(kt, units).text;
  const tmp = (c: number) => u.temperature(c, units).text;

  const cards = [
    statCard(
      "Last heard",
      live ? fmtRelative(s.lastUtc) : fmtUtc(s.lastUtc),
      live ? `${s.lastUtc.slice(11, 16)} UTC` : `first ${fmtUtc(s.firstUtc)}`,
    ),
    statCard("Altitude", alt(s.last.altitude_m), `highest ${alt(s.maxAltitudeM)}`),
    statCard(
      "Distance covered",
      u.distance(s.distanceKm, units).text,
      `${fmtInt(s.points)} reports · ${days.toFixed(1)} days`,
    ),
    statCard("Ground speed", spd(s.last.speed_kt), `fastest ${spd(s.maxSpeedKt)}`),
    statCard(
      "Battery",
      `${s.last.voltage_v.toFixed(2)} V`,
      `${Math.min(...volts).toFixed(2)}-${Math.max(...volts).toFixed(2)} V`,
    ),
    statCard(
      "Tracker temperature",
      tmp(s.last.temperature_c),
      `${u.temperature(Math.min(...temps), units).value} to ${tmp(Math.max(...temps))}`,
    ),
  ];
  return `<div class="stats">${cards.join("")}</div>`;
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
