/** Small hand-rolled SVG time-series charts. No chart library: the needs are
 * four line charts with UTC axes, and a dependency-light site is the point.
 *
 * Lines break wherever the gap between records exceeds an hour, so nightly
 * silence from the solar-only payload shows as an honest gap instead of a
 * fabricated straight line across the night. */

import { fmtInt } from "./format";

export interface ChartSpec {
  label: string;
  unit: string;
  color: string;
  values: { t: number; v: number }[];
  /** Shared time domain (ms epoch) so all charts on a page align. */
  domain: [number, number];
  decimals?: number;
}

const W = 640;
const H = 170;
const M = { top: 14, right: 12, bottom: 22, left: 52 };
const GAP_MS = 60 * 60 * 1000;

function yTicks(min: number, max: number): number[] {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag)
    .find((s) => (max - min) / s <= 5)!;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    ticks.push(v);
  }
  return ticks;
}

const TIME_STEPS_MS = [
  10, 30, 60, 180, 360, 720, 1440, 2880, 10080, 20160, 43200,
].map((min) => min * 60_000);

function xTicks(t0: number, t1: number): number[] {
  const span = t1 - t0;
  const step = TIME_STEPS_MS.find((s) => span / s <= 7) ??
    TIME_STEPS_MS[TIME_STEPS_MS.length - 1]!;
  const ticks = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    ticks.push(t);
  }
  return ticks;
}

function fmtTick(t: number, spanMs: number): string {
  const iso = new Date(t).toISOString();
  return spanMs <= 36 * 3_600_000 ? iso.slice(11, 16) : iso.slice(5, 10);
}

function fmtValue(v: number, decimals: number): string {
  return decimals === 0 ? fmtInt(Math.round(v)) : v.toFixed(decimals);
}

export function renderChart(container: HTMLElement, spec: ChartSpec): void {
  const { values, domain, decimals = 0 } = spec;
  const [t0, t1] = domain;
  const vMin = Math.min(...values.map((p) => p.v));
  const vMax = Math.max(...values.map((p) => p.v));
  const yt = yTicks(vMin, vMax);
  const yLo = Math.min(vMin, yt[0]!);
  const yHi = Math.max(vMax, yt[yt.length - 1]!);

  const x = (t: number) =>
    M.left + ((t - t0) / Math.max(1, t1 - t0)) * (W - M.left - M.right);
  const y = (v: number) =>
    H - M.bottom - ((v - yLo) / Math.max(1e-9, yHi - yLo)) * (H - M.top - M.bottom);

  const grid = yt.map((v) =>
    `<line class="chart-grid" x1="${M.left}" x2="${W - M.right}"` +
    ` y1="${y(v)}" y2="${y(v)}"/>` +
    `<text class="chart-tick" x="${M.left - 6}" y="${y(v) + 3}"` +
    ` text-anchor="end">${fmtValue(v, decimals)}</text>`).join("");

  const xAxis = xTicks(t0, t1).map((t) =>
    `<line class="chart-grid" y1="${H - M.bottom}" y2="${H - M.bottom + 4}"` +
    ` x1="${x(t)}" x2="${x(t)}"/>` +
    `<text class="chart-tick" x="${x(t)}" y="${H - 6}"` +
    ` text-anchor="middle">${fmtTick(t, t1 - t0)}</text>`).join("");

  // One <path> per contiguous run of records; runs split at silence gaps.
  const segments: string[] = [];
  let d = "";
  for (let i = 0; i < values.length; i++) {
    const p = values[i]!;
    const newRun = i === 0 || p.t - values[i - 1]!.t > GAP_MS;
    if (newRun && d) {
      segments.push(d);
      d = "";
    }
    d += `${newRun ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
  }
  if (d) segments.push(d);
  const paths = segments.map((seg) =>
    `<path class="chart-line" stroke="${spec.color}" d="${seg}"/>`).join("");
  // Per-point dots read well on a day's data and turn to mud (and thousands
  // of SVG nodes) on a two-month flight; the line carries dense series.
  const dots = values.length > 400 ? "" : values.map((p) =>
    `<circle class="chart-dot" fill="${spec.color}"` +
    ` cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="1.6"/>`).join("");

  container.classList.add("chart");
  container.innerHTML = `
    <div class="chart-head">
      <span class="chart-title">${spec.label}</span>
      <span class="chart-unit">${spec.unit}</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${spec.label} over time">
      ${grid}${xAxis}${paths}${dots}
      <circle class="chart-cursor" r="3.5" fill="${spec.color}" opacity="0"/>
      <rect class="chart-hover" x="${M.left}" y="${M.top}"
        width="${W - M.left - M.right}" height="${H - M.top - M.bottom}"
        fill="transparent"/>
    </svg>
    <div class="chart-tooltip" hidden></div>`;

  const svg = container.querySelector("svg")!;
  const cursor = svg.querySelector<SVGCircleElement>(".chart-cursor")!;
  const hover = svg.querySelector<SVGRectElement>(".chart-hover")!;
  const tooltip = container.querySelector<HTMLDivElement>(".chart-tooltip")!;

  hover.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const tAt = t0 + ((ev.clientX - rect.left) / rect.width * W - M.left) /
      (W - M.left - M.right) * (t1 - t0);
    let best = values[0]!;
    for (const p of values) {
      if (Math.abs(p.t - tAt) < Math.abs(best.t - tAt)) best = p;
    }
    cursor.setAttribute("cx", String(x(best.t)));
    cursor.setAttribute("cy", String(y(best.v)));
    cursor.setAttribute("opacity", "1");
    tooltip.hidden = false;
    tooltip.textContent = `${new Date(best.t).toISOString().slice(5, 16).replace("T", " ")}Z · ` +
      `${fmtValue(best.v, decimals)} ${spec.unit}`;
    const px = (x(best.t) / W) * rect.width;
    tooltip.style.left = `${Math.min(Math.max(px, 60), rect.width - 60)}px`;
  });
  hover.addEventListener("mouseleave", () => {
    cursor.setAttribute("opacity", "0");
    tooltip.hidden = true;
  });
}
