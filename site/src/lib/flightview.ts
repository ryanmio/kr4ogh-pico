/** Client-side flight rendering shared by both data paths: archived pages
 * feed it a static track.json from git, the live page feeds it rows from the
 * Supabase cache, so a flight looks the same either way.
 *
 * Archived pages server-render the stat strip and table at build time and
 * call renderMapInto / renderChartsInto for their own layout. The live page
 * has no build-time data and uses renderFlightView for all of it. */

import { renderChart } from "./charts";
import { parseUtc } from "./format";
import { renderMap } from "./map";
import { statsHtml, tableHtml } from "./render";
import type { FlightMeta, TrackPoint } from "./types";

export function renderMapInto(
  el: HTMLElement, meta: FlightMeta, track: TrackPoint[],
): void {
  if (!track.length && meta.launch_lat == null) return;
  el.classList.add("fv-map");
  renderMap(el, meta, track);
}

export function renderChartsInto(el: HTMLElement, track: TrackPoint[]): void {
  if (!track.length) return;
  el.classList.add("fv-charts");
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
    const chartEl = document.createElement("div");
    el.appendChild(chartEl);
    renderChart(chartEl, { ...spec, domain });
  }
}

export function renderFlightView(
  root: HTMLElement, meta: FlightMeta, track: TrackPoint[], live: boolean,
): void {
  root.innerHTML = `
    <div class="fv-map-slot"></div>
    <div class="fv-stats">${statsHtml(track, live)}</div>
    <div class="fv-charts-slot"></div>
    ${tableHtml(track)}`;
  renderMapInto(root.querySelector<HTMLElement>(".fv-map-slot")!, meta, track);
  renderChartsInto(root.querySelector<HTMLElement>(".fv-charts-slot")!, track);
}
