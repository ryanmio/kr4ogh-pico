/** Client-side flight rendering shared by both data paths — archived pages
 * feed it a static track.json from git, the live page feeds it rows from the
 * Supabase cache — so a flight looks the same the day it closes as the day
 * it flew.
 *
 * Archived pages server-render the stat strip and table at build time and
 * only call renderMapAndCharts; the live page renders everything client-side
 * with renderFlightView. */

import { renderChart } from "./charts";
import { parseUtc } from "./format";
import { renderMap } from "./map";
import { statsHtml, tableHtml } from "./render";
import type { FlightMeta, TrackPoint } from "./types";

export function renderMapAndCharts(
  root: HTMLElement, meta: FlightMeta, track: TrackPoint[],
): void {
  root.innerHTML = `
    ${track.length || meta.launch_lat != null ? '<div class="fv-map"></div>' : ""}
    ${track.length ? '<div class="fv-charts"></div>' : ""}`;

  const mapEl = root.querySelector<HTMLElement>(".fv-map");
  if (mapEl) renderMap(mapEl, meta, track);

  const chartsEl = root.querySelector<HTMLElement>(".fv-charts");
  if (chartsEl && track.length) {
    const t = track.map((p) => parseUtc(p.utc).getTime());
    const domain: [number, number] = [t[0]!, t[t.length - 1]!];
    const series = (get: (p: TrackPoint) => number) =>
      track.map((p, i) => ({ t: t[i]!, v: get(p) }));
    const specs = [
      { label: "Altitude", unit: "m", color: "#7dd3fc",
        values: series((p) => p.altitude_m), decimals: 0 },
      { label: "Speed", unit: "kt", color: "#a78bfa",
        values: series((p) => p.speed_kt), decimals: 0 },
      { label: "Voltage", unit: "V", color: "#34d399",
        values: series((p) => p.voltage_v), decimals: 2 },
      { label: "Die temperature", unit: "°C", color: "#fb923c",
        values: series((p) => p.temperature_c), decimals: 0 },
    ];
    for (const spec of specs) {
      const el = document.createElement("div");
      chartsEl.appendChild(el);
      renderChart(el, { ...spec, domain });
    }
  }
}

export function renderFlightView(
  root: HTMLElement, meta: FlightMeta, track: TrackPoint[], live: boolean,
): void {
  root.innerHTML = `
    <div class="fv-stats">${statsHtml(track, live)}</div>
    <div class="fv-mapcharts"></div>
    <div class="fv-table">${tableHtml(track)}</div>`;
  renderMapAndCharts(root.querySelector<HTMLElement>(".fv-mapcharts")!, meta, track);
}
