/** HTML string builders shared by build-time rendering and the browser, so a
 * flight looks the same whether its numbers came from the committed track or
 * from a live wspr.live query. */

import {
  bearingDeg, compassPoint, fmtDuration, fmtInt, fmtRelative, fmtUtc, haversineKm,
  parseUtc, trackStats,
} from "./format";
import { heardBounds } from "./ghosts";
import { lastSensorFix, METRICS, metricAvailable, type MetricKey } from "./metrics";
import {
  groundSpeedKt, hasSaturatedSpeed, isSpeedFloor, speedText, SPEED_CEILING_KT,
} from "./speed";
import type { FlightMeta, GhostPoint } from "./types";
import * as u from "./units";
import type { Units } from "./units";
import type { TrackPoint } from "./types";

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
  pressure:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="8.5"/><path d="M12 12l3.2-4.6"/>' +
    '<path d="M7 15.5h1.2M15.8 15.5H17M12 5.5v1.2"/>' +
    '<circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>',
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
 * the reader asks. The map's coloring is named by its own legend.
 *
 * `ghosts` are the slots heard without telemetry. They count as the
 * tracker being heard -- "last heard" and "flying for" take them in -- and
 * as nothing else: every number on the metric cards is from the last full
 * fix, because a ghost carries none of them. */
export function sidebarHtml(
  meta: FlightMeta, track: TrackPoint[], units: Units, active: ActiveCard,
  opts: { pending?: boolean; ghosts?: GhostPoint[] } = {},
): string {
  const ended = meta.status === "closed";
  const ghosts = opts.ghosts ?? [];
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
      track&hellip;</p></div>`;
  }
  const s = trackStats(track);
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
    return tracker + `<div class="fv-status"><p class="empty-note">${note}</p></div>`;
  }
  const heard = heardBounds(track, ghosts)!;
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
  const aloftMs = parseUtc(heard.lastUtc).getTime() - parseUtc(heard.firstUtc).getTime();
  const fromLaunchKm = haversineKm(
    track[0]!.lat, track[0]!.lon, s.last.lat, s.last.lon);

  // Shaped like every other card: a label, one line that never wraps, a
  // sub line. A closed flight says only that it ended; the date it was
  // last heard, and whether that newest report was position-only, are in
  // the Signal panel. The dot stops pulsing when the flight is over.
  const partial = ghosts.length
    ? ` · ${fmtInt(ghosts.length)} without telemetry`
    : "";
  const status = `<button type="button" class="fv-card fv-status" data-panel="status"
    aria-pressed="${active === "status"}">
    <span class="fv-card-icon" style="color:${ended ? "#94a3b8" : "#34d399"}"><span
      class="fv-status-dot${ended ? " fv-status-dot-ended" : ""}"></span></span>
    <span class="fv-card-text">
      <span class="fv-card-label">Signal</span>
      <span class="fv-card-value">${ended
        ? "Flight ended"
        : `Heard ${esc(fmtRelative(heard.lastUtc))}`}</span>
      <span class="fv-card-sub">${ended ? "flew" : "flying"} for ${esc(fmtDuration(aloftMs))}
        · ${fmtInt(s.points)} reports${partial}</span>
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
    ...pressureCard(track, s.last, units, active),
    metricCard("speed", speedText(s.last, units), `fastest ${spd(s.maxSpeedKt)}`, active),
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

/** The Air pressure card, on a flight whose tracker has sent a reading;
 * nothing at all on any other, so a stock tracker's sidebar is unchanged.
 *
 * One card carries the whole sensor: pressure is the value, because a
 * balloon floats at a pressure level and that is the number worth a chart,
 * and the sub line carries the other two readings. The newest reading may
 * be older than the newest fix, when the sensor message of the last cycle
 * was not heard; then the sub line says when it is from instead. */
function pressureCard(
  track: TrackPoint[], last: TrackPoint, units: Units, active: ActiveCard,
): string[] {
  if (!metricAvailable("pressure", track)) return [];
  const p = lastSensorFix(track)!;
  const sub = p === last
    ? `${p.humidity_pct} % RH · board ${u.temperature(p.board_temp_c!, units).text}`
    : `${p.humidity_pct} % RH · at ${p.utc.slice(11, 16)} UTC`;
  return [metricCard("pressure", `${p.pressure_hpa} hPa`, sub, active)];
}

/** The speed column. A fix under the field's ceiling prints the integer the
 * tracker sent. At the ceiling the tracker only proved a lower bound, so the
 * cell prints either "82+" or the tilde-marked estimate the track measured,
 * never a bare 82 that would read as a measurement. */
function speedCell(p: TrackPoint): string {
  if (!isSpeedFloor(p) && p.speed_kt_est === undefined) return `${p.speed_kt}`;
  return isSpeedFloor(p)
    ? `${p.speed_kt}+`
    : `~${Math.round(groundSpeedKt(p))}`;
}

/** Telemetry table, newest first. Long flights are capped so a two-month
 * flight stays a reasonable download; the full track is always in the
 * flight's JSON. */
export function tableHtml(track: TrackPoint[], maxRows = 500): string {
  if (track.length === 0) return "";
  const capped = track.length > maxRows;
  // The sensor columns exist only on a flight that has sent a reading, and
  // a fix whose reading was not heard leaves them blank.
  const sensor = metricAvailable("pressure", track);
  const sensorCells = (p: TrackPoint) => sensor
    ? `<td class="mono num">${p.pressure_hpa ?? ""}</td>
    <td class="mono num">${p.board_temp_c ?? ""}</td>
    <td class="mono num">${p.humidity_pct ?? ""}</td>`
    : "";
  const sensorHeads = sensor
    ? "<th>hPa</th><th>Board (°C)</th><th>RH (%)</th>" : "";
  const rows = [...track].reverse().slice(0, maxRows).map((p) => `<tr>
    <td class="mono">${esc(fmtUtc(p.utc))}</td>
    <td class="mono">${esc(p.grid6)}</td>
    <td class="mono num">${p.lat.toFixed(4)}</td>
    <td class="mono num">${p.lon.toFixed(4)}</td>
    <td class="mono num">${fmtInt(p.altitude_m)}</td>
    <td class="mono num">${speedCell(p)}</td>
    <td class="mono num">${p.voltage_v.toFixed(2)}</td>
    <td class="mono num">${p.temperature_c}</td>
    ${sensorCells(p)}
    <td class="mono num">${p.rx_station_count}</td>
  </tr>`);
  const label = capped
    ? `Telemetry table · latest ${fmtInt(maxRows)} of ${fmtInt(track.length)}` +
      " records (full track in the JSON download)"
    : `Telemetry table · ${fmtInt(track.length)} records`;
  // Only worth the line on a flight that actually hit the ceiling, which is
  // the only flight where the column needs explaining.
  const ceilingNote = hasSaturatedSpeed(track)
    ? `<p class="fv-panel-note">The speed field stops at
      ${SPEED_CEILING_KT} kt, so "${SPEED_CEILING_KT}+" is the tracker saying
      "at least this". A "~" speed is measured from the distance flown either
      side of the fix instead.</p>`
    : "";
  return `<details class="telemetry-table">
    <summary>${label}</summary>
    ${ceilingNote}
    <div class="table-scroll"><table>
      <thead><tr>
        <th>UTC</th><th>Grid</th><th>Lat</th><th>Lon</th>
        <th>Alt (m)</th><th>Speed (kt)</th><th>Volts</th>
        <th>Die temp (°C)</th>${sensorHeads}<th>RX stations</th>
      </tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table></div>
  </details>`;
}
