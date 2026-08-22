/** HTML string builders shared by build-time rendering (archived pages) and
 * the browser (live pages). One source for the markup means the two data
 * paths — git archive and Supabase cache — always look identical. */

import { fmtCoord, fmtInt, fmtRelative, fmtUtc, trackStats } from "./format";
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

/** The stat strip above the map. `live` switches "last heard" to relative
 * time, which only makes sense while a flight is still flying. */
export function statsHtml(track: TrackPoint[], live: boolean): string {
  const s = trackStats(track);
  if (!s) {
    return '<p class="empty-note">No decoded telemetry yet.</p>';
  }
  const days =
    (Date.parse(s.lastUtc) - Date.parse(s.firstUtc)) / 86_400_000;
  const volts = track.map((p) => p.voltage_v);
  const temps = track.map((p) => p.temperature_c);
  const cards = [
    statCard(
      "Last heard",
      live ? fmtRelative(s.lastUtc) : fmtUtc(s.lastUtc),
      live ? fmtUtc(s.lastUtc) : `first ${fmtUtc(s.firstUtc)}`,
    ),
    statCard(
      "Position",
      s.last.grid6,
      fmtCoord(s.last.lat, s.last.lon),
    ),
    statCard(
      "Altitude",
      `${fmtInt(s.last.altitude_m)} m`,
      `max ${fmtInt(s.maxAltitudeM)} m`,
    ),
    statCard(
      "Track",
      `${fmtInt(Math.round(s.distanceKm))} km`,
      `${fmtInt(s.points)} records over ${days.toFixed(1)} days`,
    ),
    statCard(
      "Speed",
      `${s.last.speed_kt} kt`,
      `max ${s.maxSpeedKt} kt`,
    ),
    statCard(
      "Volts / die temp",
      `${s.last.voltage_v.toFixed(2)} V · ${s.last.temperature_c} °C`,
      `${Math.min(...volts).toFixed(2)}–${Math.max(...volts).toFixed(2)} V · ` +
        `${Math.min(...temps)}–${Math.max(...temps)} °C`,
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
export function flightCardHtml(o: {
  href: string;
  title: string;
  badge: string;
  badgeClass: string;
  meta: string;
  summary: string;
}): string {
  return `<a class="flight-card" href="${esc(o.href)}">
    <div class="flight-card-top">
      <h3>${esc(o.title)}</h3>
      <span class="badge ${esc(o.badgeClass)}">${esc(o.badge)}</span>
    </div>
    <p class="flight-card-meta mono">${esc(o.meta)}</p>
    <p class="flight-card-summary">${esc(o.summary)}</p>
  </a>`;
}
