/** Client-side map and chart rendering, shared by the live view and archived
 * flight pages so a flight looks the same either way. Both server-render
 * their summary HTML at build time and call these for the interactive
 * parts. */

import type L from "leaflet";
import { renderChart } from "./charts";
import { parseUtc } from "./format";
import { convert, unitLabels, type Units } from "./units";
import { renderMap, type MapOptions } from "./map";
import { groundSpeedKt } from "./speed";
import type { FlightMeta, TrackPoint } from "./types";

/** Returns the Leaflet map, or null when there was nothing to draw. Callers
 * that re-render must call remove() on it first; see renderMap. */
export function renderMapInto(
  el: HTMLElement, meta: FlightMeta, track: TrackPoint[],
  opts: MapOptions = {},
): L.Map | null {
  if (!track.length && !opts.ghosts?.length && !opts.overlays?.length
    && meta.launch_lat == null) return null;
  el.classList.add(opts.sizing === "fill" ? "fv-map-fill" : "fv-map");
  return renderMap(el, meta, track, opts);
}

/** One chart per row, full width, each its own block to scroll past.
 *
 * Altitude, speed, battery and temperature are the four things people
 * actually want to watch, so none of them is squeezed into a half-width
 * column beside another. Charts are drawn in the reader's chosen units; the
 * stored track stays metric.
 */
export function renderChartsInto(
  el: HTMLElement, track: TrackPoint[], units: Units = "metric",
): void {
  if (!track.length) return;
  el.classList.add("fv-charts");
  const labels = unitLabels(units);
  const t = track.map((p) => parseUtc(p.utc).getTime());
  const domain: [number, number] = [t[0]!, t[t.length - 1]!];
  const series = (get: (p: TrackPoint) => number) =>
    track.map((p, i) => ({ t: t[i]!, v: get(p) }));
  const specs = [
    {
      label: "Altitude", unit: labels.altitude, color: "#7dd3fc",
      values: series((p) => convert.altitude(p.altitude_m, units)), decimals: 0,
    },
    {
      label: "Ground speed", unit: labels.speed, color: "#a78bfa",
      values: series((p) => convert.speed(groundSpeedKt(p), units)), decimals: 0,
    },
    {
      label: "Battery", unit: "V", color: "#34d399",
      values: series((p) => p.voltage_v), decimals: 2,
    },
    {
      label: "Tracker temperature", unit: labels.temperature, color: "#fb923c",
      values: series((p) => convert.temperature(p.temperature_c, units)), decimals: 0,
    },
  ];
  for (const spec of specs) {
    const section = document.createElement("section");
    section.className = "fv-chart";
    el.appendChild(section);
    renderChart(section, { ...spec, domain });
  }
}
