import { c as createAstro, a as createComponent, e as addAttribute, i as renderHead, d as renderTemplate, j as renderSlot } from './astro/server_DdaXy4vm.mjs';
import 'piccolore';
import 'clsx';
/* empty css                         */

function withBase(path) {
  const base = "/";
  return (base.endsWith("/") ? base : base + "/") + path.replace(/^\//, "");
}

const $$Astro = createAstro("https://kr4ogh-pico.vercel.app");
const $$Base = createComponent(($$result, $$props, $$slots) => {
  const Astro2 = $$result.createAstro($$Astro, $$props, $$slots);
  Astro2.self = $$Base;
  const {
    title,
    description = "KR4OGH pico balloon flights: live WSPR telemetry and archived tracks.",
    chrome = true
  } = Astro2.props;
  const canonical = new URL(Astro2.url.pathname, Astro2.site).href;
  const ogImage = new URL(withBase("/og.png"), Astro2.site).href;
  return renderTemplate`<html lang="en"> <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description"${addAttribute(description, "content")}><link rel="canonical"${addAttribute(canonical, "href")}><link rel="icon"${addAttribute(withBase("/favicon.svg"), "href")} type="image/svg+xml"><title>${title}</title><!-- Share cards. X falls back to the og: tags when no twitter:* ones
         exist, so only the card size is worth saying twice. --><meta property="og:type" content="website"><meta property="og:title"${addAttribute(title, "content")}><meta property="og:description"${addAttribute(description, "content")}><meta property="og:url"${addAttribute(canonical, "content")}><meta property="og:image"${addAttribute(ogImage, "content")}><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="KR4OGH pico balloon, live telemetry tracking: a dashed track climbing from a grey launch dot to a lit balloon."><meta name="twitter:card" content="summary_large_image">${renderHead()}</head> <body> ${chrome && renderTemplate`<header class="site-header"> <div class="container"> <a class="site-title"${addAttribute(withBase("/"), "href")}>KR4OGH<span class="tld">.balloon</span></a> </div> </header>`} ${chrome ? renderTemplate`<main><div class="container">${renderSlot($$result, $$slots["default"])}</div></main>` : renderTemplate`<main class="bare">${renderSlot($$result, $$slots["default"])}</main>`} ${chrome && renderTemplate`<footer class="site-footer"> <div class="container"> <span>KR4OGH pico balloon program</span> <a href="https://github.com/ryanmio/kr4ogh-pico">Source &amp; data</a> <a href="https://wspr.live/">Spots: wspr.live</a> <a href="https://traquito.github.io/">Trackers: Traquito</a> </div> </footer>`} </body></html>`;
}, "/vercel/sandbox/primary/site/src/layouts/Base.astro", void 0);

function parseUtc(utc) {
  const iso = utc.includes("T") ? utc : utc.replace(" ", "T");
  const zoned = /([Zz]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
  return new Date(zoned);
}
function fmtUtc(utc) {
  const d = typeof utc === "string" ? parseUtc(utc) : utc;
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
function fmtUtcShort(d) {
  return d.toISOString().slice(5, 16).replace("T", " ");
}
function fmtRelative(utc, now = /* @__PURE__ */ new Date()) {
  const ms = now.getTime() - parseUtc(utc).getTime();
  const min = Math.round(ms / 6e4);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${min % 60}m ago`;
  return `${Math.floor(h / 24)} days ago`;
}
function fmtInt(n) {
  return n.toLocaleString("en-US");
}
function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / 6e4));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function bearingDeg(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLon = (lon2 - lon1) * rad;
  const y = Math.sin(dLon) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos(dLon);
  return (Math.atan2(y, x) / rad + 360) % 360;
}
function compassPoint(deg) {
  const points = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW"
  ];
  return points[Math.round(deg / 22.5) % 16];
}
const EARTH_RADIUS_KM = 6371;
function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}
function trackStats(track) {
  if (track.length === 0) return null;
  let distanceKm = 0;
  let maxAltitudeM = -Infinity;
  let maxSpeedKt = -Infinity;
  for (let i = 0; i < track.length; i++) {
    const p = track[i];
    maxAltitudeM = Math.max(maxAltitudeM, p.altitude_m);
    maxSpeedKt = Math.max(maxSpeedKt, p.speed_kt_est ?? p.speed_kt);
    if (i > 0) {
      const q = track[i - 1];
      distanceKm += haversineKm(q.lat, q.lon, p.lat, p.lon);
    }
  }
  return {
    points: track.length,
    firstUtc: track[0].utc,
    lastUtc: track[track.length - 1].utc,
    maxAltitudeM,
    maxSpeedKt,
    distanceKm,
    last: track[track.length - 1]
  };
}

const M_TO_FT = 3.280839895;
const KM_TO_MI = 0.621371192;
const KT_TO_KMH = 1.852;
const KT_TO_MPH = 1.150779448;
function measure(value, unit, decimals) {
  const rounded = Number(value.toFixed(decimals));
  return {
    value: rounded,
    unit,
    text: `${rounded.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    })} ${unit}`
  };
}
function altitude(m, units) {
  return units === "imperial" ? measure(m * M_TO_FT, "ft", 0) : measure(m, "m", 0);
}
function distance(km, units) {
  return units === "imperial" ? measure(km * KM_TO_MI, "mi", 0) : measure(km, "km", 0);
}
function speed(kt, units) {
  return units === "imperial" ? measure(kt * KT_TO_MPH, "mph", 0) : measure(kt * KT_TO_KMH, "km/h", 0);
}
function temperature(c, units) {
  return units === "imperial" ? measure(c * 9 / 5 + 32, "°F", 0) : measure(c, "°C", 0);
}

const SPEED_CEILING_KT = 82;
const MIN_BASELINE_MS = 40 * 60 * 1e3;
const MAX_LEG_MS = 40 * 60 * 1e3;
const KM_PER_NM = 1.852;
function isSpeedSaturated(p) {
  return p.speed_kt >= SPEED_CEILING_KT;
}
function groundSpeedKt(p) {
  return p.speed_kt_est ?? p.speed_kt;
}
function isSpeedFloor(p) {
  return p.speed_source === "floor";
}
function hasSaturatedSpeed(track) {
  return track.some(isSpeedSaturated);
}
function speedText(p, units) {
  const m = speed(groundSpeedKt(p), units);
  return isSpeedFloor(p) ? `${m.value.toLocaleString("en-US")}+ ${m.unit}` : m.text;
}
function resolveTrackSpeeds(track) {
  if (!hasSaturatedSpeed(track)) return track;
  const t = track.map((p) => parseUtc(p.utc).getTime());
  return track.map((p, i) => {
    if (!isSpeedSaturated(p)) return p;
    const derived = windowSpeedKt(track, t, i);
    return derived !== null && derived > SPEED_CEILING_KT ? { ...p, speed_kt_est: Math.round(derived * 10) / 10, speed_source: "derived" } : { ...p, speed_kt_est: SPEED_CEILING_KT, speed_source: "floor" };
  });
}
function windowSpeedKt(track, t, i) {
  let a = i;
  let b = i;
  while (t[b] - t[a] < MIN_BASELINE_MS) {
    const canBack = a > 0 && t[a] - t[a - 1] <= MAX_LEG_MS;
    const canFwd = b < track.length - 1 && t[b + 1] - t[b] <= MAX_LEG_MS;
    if (!canBack && !canFwd) break;
    if (canBack && (!canFwd || t[i] - t[a] <= t[b] - t[i])) a--;
    else b++;
  }
  const elapsedMs = t[b] - t[a];
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  let km = 0;
  for (let j = a; j < b; j++) {
    km += haversineKm(track[j].lat, track[j].lon, track[j + 1].lat, track[j + 1].lon);
  }
  return km / KM_PER_NM / (elapsedMs / 36e5);
}

const METRICS = {
  journey: {
    key: "journey",
    label: "Journey",
    ramp: ["#64748b", "#38bdf8", "#f8fafc"],
    color: "#38bdf8",
    raw: (p) => parseUtc(p.utc).getTime(),
    fmt: (raw) => fmtUtcShort(new Date(raw))
  },
  altitude: {
    key: "altitude",
    label: "Altitude",
    ramp: ["#3b82f6", "#22d3ee", "#fde047"],
    color: "#7dd3fc",
    raw: (p) => p.altitude_m,
    fmt: (raw, units) => altitude(raw, units).text
  },
  speed: {
    key: "speed",
    label: "Ground speed",
    ramp: ["#a78bfa", "#f472b6", "#fb923c"],
    color: "#f472b6",
    raw: (p) => groundSpeedKt(p),
    fmt: (raw, units) => speed(raw, units).text
  },
  voltage: {
    key: "voltage",
    label: "Voltage",
    ramp: ["#f87171", "#facc15", "#34d399"],
    color: "#34d399",
    raw: (p) => p.voltage_v,
    fmt: (raw) => `${raw.toFixed(2)} V`
  },
  temperature: {
    key: "temperature",
    label: "Tracker temp",
    ramp: ["#60a5fa", "#c084fc", "#fb7185"],
    color: "#fb7185",
    raw: (p) => p.temperature_c,
    fmt: (raw, units) => temperature(raw, units).text
  },
  receivers: {
    key: "receivers",
    label: "Receivers",
    ramp: ["#64748b", "#a78bfa", "#f0abfc"],
    color: "#a78bfa",
    raw: (p) => p.rx_station_count,
    fmt: (raw) => `${Math.round(raw)}`
  }
};

function esc(s) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
function statCard(label, value, sub) {
  return `<div class="stat">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value">${esc(value)}</div>
    <div class="stat-sub">${esc(sub)}</div>
  </div>`;
}
function statsHtml(track, live, units = "metric") {
  const s = trackStats(track);
  if (!s) {
    return '<p class="empty-note">No decoded telemetry yet.</p>';
  }
  const volts = track.map((p) => p.voltage_v);
  const temps = track.map((p) => p.temperature_c);
  const alt = (m) => altitude(m, units).text;
  const spd = (kt) => speed(kt, units).text;
  const tmp = (c) => temperature(c, units).text;
  const prev = track.length >= 2 ? track[track.length - 2] : null;
  const heading = prev ? bearingDeg(prev.lat, prev.lon, s.last.lat, s.last.lon) : null;
  const aloftMs = Date.parse(s.lastUtc) - Date.parse(s.firstUtc);
  const fromLaunchKm = haversineKm(
    track[0].lat,
    track[0].lon,
    s.last.lat,
    s.last.lon
  );
  const cards = [
    statCard(
      "Last heard",
      fmtUtc(s.lastUtc),
      `first ${fmtUtc(s.firstUtc)}`
    ),
    statCard(
      "Time in the air",
      fmtDuration(aloftMs),
      `since ${s.firstUtc.slice(11, 16)} UTC`
    ),
    statCard("Altitude", alt(s.last.altitude_m), `highest ${alt(s.maxAltitudeM)}`),
    statCard("Ground speed", speedText(s.last, units), `fastest ${spd(s.maxSpeedKt)}`),
    statCard(
      "Heading",
      heading === null ? "--" : compassPoint(heading),
      heading === null ? "needs two fixes" : `${Math.round(heading)}° from north`
    ),
    statCard(
      "Distance flown",
      distance(s.distanceKm, units).text,
      `${distance(fromLaunchKm, units).text} from launch`
    ),
    statCard(
      "Battery",
      `${s.last.voltage_v.toFixed(2)} V`,
      `${Math.min(...volts).toFixed(2)}-${Math.max(...volts).toFixed(2)} V`
    ),
    statCard(
      "Tracker temp",
      tmp(s.last.temperature_c),
      `${temperature(Math.min(...temps), units).value} to ${tmp(Math.max(...temps))}`
    )
  ];
  return `<div class="stats">${cards.join("")}</div>`;
}
const ICONS = {
  journey: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2.2 4.8-4.8 2.2 2.2-4.8z" fill="currentColor" stroke="none"/></svg>',
  altitude: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18l6-11 4 7 3-4 5 8z"/></svg>',
  speed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 17.5a8 8 0 1 1 14 0"/><path d="M12 14l4.5-4.5"/></svg>',
  voltage: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2.5L5 13.5h5.5L11 21.5l8-11h-5.5z"/></svg>',
  temperature: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4a2 2 0 0 1 4 0v9.3a4 4 0 1 1-4 0z"/><path d="M12 9v6"/></svg>',
  receivers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9.5" r="1.7" fill="currentColor" stroke="none"/><path d="M12 11.5V20"/><path d="M8.7 12.8a4.6 4.6 0 0 1 0-6.6M15.3 6.2a4.6 4.6 0 0 1 0 6.6"/><path d="M6.2 15.3a8 8 0 0 1 0-11.6M17.8 3.7a8 8 0 0 1 0 11.6"/></svg>'
};
const TRACKER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5a6 6 0 0 1 6 6c0 3.7-2.7 6.7-6 6.7s-6-3-6-6.7a6 6 0 0 1 6-6z"/><path d="M10.8 15l-.8 2.5h4l-.8-2.5"/><path d="M12 17.5V21"/></svg>';
function metricCard(key, value, sub, active) {
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
function sidebarHtml(meta, track, units, active) {
  const tracker = `<button type="button" class="fv-card fv-card-wide"
    data-panel="tracker" aria-pressed="${active === "tracker"}">
    <span class="fv-card-icon" style="color:#e2e8f0">${TRACKER_ICON}</span>
    <span class="fv-card-text">
      <span class="fv-card-label">Tracker</span>
      <span class="fv-card-value">${esc(meta.callsign)} · ${esc(meta.flight_id)}</span>
      <span class="fv-card-sub">${esc(meta.band)} ch ${meta.channel}${meta.launch_utc ? " · up since " + esc(meta.launch_utc.slice(5, 10)) : ""}</span>
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
  const alt = (m) => altitude(m, units).text;
  const spd = (kt) => speed(kt, units).text;
  const tmp = (c) => temperature(c, units).text;
  const prev = track.length >= 2 ? track[track.length - 2] : null;
  const heading = prev ? bearingDeg(prev.lat, prev.lon, s.last.lat, s.last.lon) : null;
  const aloftMs = Date.parse(s.lastUtc) - Date.parse(s.firstUtc);
  const fromLaunchKm = haversineKm(
    track[0].lat,
    track[0].lon,
    s.last.lat,
    s.last.lon
  );
  const status = `<button type="button" class="fv-status" data-panel="status"
    aria-pressed="${active === "status"}">
    <span class="fv-card-icon" style="color:#34d399"><span class="fv-status-dot"></span></span>
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
      distance(s.distanceKm, units).text,
      heading === null ? "flown so far" : `${compassPoint(heading)} · ${distance(fromLaunchKm, units).text} from launch`,
      active
    ),
    metricCard("altitude", alt(s.last.altitude_m), `peak ${alt(s.maxAltitudeM)}`, active),
    metricCard("speed", speedText(s.last, units), `fastest ${spd(s.maxSpeedKt)}`, active),
    metricCard(
      "voltage",
      `${s.last.voltage_v.toFixed(2)} V`,
      `${Math.min(...volts).toFixed(2)}–${Math.max(...volts).toFixed(2)} V seen`,
      active
    ),
    metricCard(
      "temperature",
      tmp(s.last.temperature_c),
      `${temperature(Math.min(...temps), units).value} to ${tmp(Math.max(...temps))}`,
      active
    ),
    metricCard(
      "receivers",
      fmtInt(s.last.rx_station_count),
      "stations heard the last report",
      active
    )
  ];
  return tracker + status + cards.join("");
}
function speedCell(p) {
  if (!isSpeedFloor(p) && p.speed_kt_est === void 0) return `${p.speed_kt}`;
  return isSpeedFloor(p) ? `${p.speed_kt}+` : `~${Math.round(groundSpeedKt(p))}`;
}
function tableHtml(track, maxRows = 500) {
  if (track.length === 0) return "";
  const capped = track.length > maxRows;
  const rows = [...track].reverse().slice(0, maxRows).map((p) => `<tr>
    <td class="mono">${esc(fmtUtc(p.utc))}</td>
    <td class="mono">${esc(p.grid6)}</td>
    <td class="mono num">${p.lat.toFixed(4)}</td>
    <td class="mono num">${p.lon.toFixed(4)}</td>
    <td class="mono num">${fmtInt(p.altitude_m)}</td>
    <td class="mono num">${speedCell(p)}</td>
    <td class="mono num">${p.voltage_v.toFixed(2)}</td>
    <td class="mono num">${p.temperature_c}</td>
    <td class="mono num">${p.rx_station_count}</td>
  </tr>`);
  const label = capped ? `Telemetry table · latest ${fmtInt(maxRows)} of ${fmtInt(track.length)} records (full track in the JSON download)` : `Telemetry table · ${fmtInt(track.length)} records`;
  const ceilingNote = hasSaturatedSpeed(track) ? `<p class="fv-panel-note">The speed field stops at
      ${SPEED_CEILING_KT} kt, so "${SPEED_CEILING_KT}+" is the tracker saying
      "at least this". A "~" speed is measured from the distance flown either
      side of the fix instead.</p>` : "";
  return `<details class="telemetry-table">
    <summary>${label}</summary>
    ${ceilingNote}
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
function outcomeBadgeClass(outcome) {
  return {
    Pass: "badge-pass",
    Fail: "badge-fail",
    Wounded: "badge-wounded",
    Closed: "badge-closed",
    Sample: "badge-sample"
  }[outcome] ?? "badge-closed";
}

export { $$Base as $, sidebarHtml as a, outcomeBadgeClass as o, resolveTrackSpeeds as r, statsHtml as s, tableHtml as t, withBase as w };
