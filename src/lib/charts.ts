/** Small hand-rolled SVG time-series charts. No chart library: the needs are
 * four line charts with time axes in the viewer's zone, and a dependency-light site is the point.
 *
 * Lines break wherever the gap between records exceeds an hour, so nightly
 * silence from the solar-only payload shows as an honest gap instead of a
 * fabricated straight line across the night. A chart can also fold those
 * silences away (foldGaps), so the days fill the width and each night is a
 * dotted line. */

import { fmtDuration, fmtInt, fmtLocal, fmtLocalDay, fmtLocalTime } from "./format";

export interface ChartSpec {
  label: string;
  unit: string;
  color: string;
  values: { t: number; v: number }[];
  /** Shared time domain (ms epoch) so all charts on a page align. */
  domain: [number, number];
  decimals?: number;
  /** viewBox size; the SVG itself scales to its container's width. The
   * detail panel passes a wide box so its one chart spans the panel. */
  width?: number;
  height?: number;
  /** Fold each long silence (a night, mostly) down to a narrow band marked
   * by a dotted line, so the days carry the width. Off for a chart whose
   * subject is the silences themselves. */
  foldGaps?: boolean;
}

const DEFAULT_W = 640;
const DEFAULT_H = 170;
const M = { top: 14, right: 12, bottom: 22, left: 52 };
const GAP_MS = 60 * 60 * 1000;
/** A silence this long folds. Three hours clears the daytime misses (a
 * report or three not heard) and catches every night, which runs ten
 * hours and more for a solar-only tracker. */
const FOLD_MS = 3 * 60 * 60 * 1000;
/** A fold this long is labelled with its length: past a day it is no
 * longer just a night, and the band alone would hide that. */
const LONG_FOLD_MS = 26 * 60 * 60 * 1000;

interface Fold { from: number; to: number }

/** Time to x along a plot whose long silences are folded to `band` units
 * each. Time inside a day keeps its proportion, so a day's shape is true;
 * only the silences between days lose theirs. */
function foldedScale(t0: number, t1: number, folds: Fold[], left: number,
  plotW: number, band: number) {
  const kept = Math.max(1, (t1 - t0) - folds.reduce((a, f) => a + f.to - f.from, 0));
  const perMs = (plotW - folds.length * band) / kept;
  return (t: number): number => {
    let x = left + (t - t0) * perMs;
    for (const f of folds) {
      if (t >= f.to) x += band - (f.to - f.from) * perMs;
      else if (t > f.from) x += (band * (t - f.from)) / (f.to - f.from) -
        (t - f.from) * perMs;
    }
    return x;
  };
}

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

const DAY_MS = 86_400_000;

/** Ticks fall on round local times: midnight, noon, the top of an hour.
 * Counted from UTC midnight they would land at 20:00 and 02:00 for a reader
 * on the US east coast, which is where the labels now say they are. */
function xTicks(t0: number, t1: number, shown = t1 - t0): number[] {
  // Spaced by the time actually on screen, which a folded axis shortens.
  const span = shown;
  const step = TIME_STEPS_MS.find((s) => span / s <= 7) ??
    TIME_STEPS_MS[TIME_STEPS_MS.length - 1]!;
  const ticks = [];
  const base = new Date(t0);
  base.setHours(0, 0, 0, 0);
  if (step >= DAY_MS) {
    // Stride by calendar days so a tick stays on midnight across a DST change.
    const days = Math.round(step / DAY_MS);
    for (const d = base; d.getTime() <= t1; d.setDate(d.getDate() + days)) {
      if (d.getTime() >= t0) ticks.push(d.getTime());
    }
  } else {
    for (let t = base.getTime(); t <= t1; t += step) {
      if (t >= t0) ticks.push(t);
    }
  }
  return ticks;
}

function fmtTick(t: number, spanMs: number): string {
  const d = new Date(t);
  return spanMs <= 36 * 3_600_000 ? fmtLocalTime(d) : fmtLocalDay(d);
}

function fmtValue(v: number, decimals: number): string {
  return decimals === 0 ? fmtInt(Math.round(v)) : v.toFixed(decimals);
}

export function renderChart(container: HTMLElement, spec: ChartSpec): void {
  const { values, domain, decimals = 0 } = spec;
  const W = spec.width ?? DEFAULT_W;
  const H = spec.height ?? DEFAULT_H;
  const [t0, t1] = domain;
  const vMin = Math.min(...values.map((p) => p.v));
  const vMax = Math.max(...values.map((p) => p.v));
  const yt = yTicks(vMin, vMax);
  const yLo = Math.min(vMin, yt[0]!);
  const yHi = Math.max(vMax, yt[yt.length - 1]!);

  const plotW = W - M.left - M.right;
  const folds: Fold[] = [];
  if (spec.foldGaps) {
    for (let i = 1; i < values.length; i++) {
      const a = values[i - 1]!.t, b = values[i]!.t;
      if (b - a >= FOLD_MS) folds.push({ from: a, to: b });
    }
  }
  const band = Math.max(8, plotW * 0.012);
  const x = folds.length
    ? foldedScale(t0, t1, folds, M.left, plotW, band)
    : (t: number) => M.left + ((t - t0) / Math.max(1, t1 - t0)) * plotW;
  const y = (v: number) =>
    H - M.bottom - ((v - yLo) / Math.max(1e-9, yHi - yLo)) * (H - M.top - M.bottom);

  const grid = yt.map((v) =>
    `<line class="chart-grid" x1="${M.left}" x2="${W - M.right}"` +
    ` y1="${y(v)}" y2="${y(v)}"/>` +
    `<text class="chart-tick" x="${M.left - 6}" y="${y(v) + 3}"` +
    ` text-anchor="end">${fmtValue(v, decimals)}</text>`).join("");

  const tick = (t: number, label: string, mark = true) =>
    (mark ? `<line class="chart-grid" y1="${H - M.bottom}" y2="${H - M.bottom + 4}"` +
      ` x1="${x(t)}" x2="${x(t)}"/>` : "") +
    `<text class="chart-tick" x="${x(t)}" y="${H - 6}"` +
    ` text-anchor="middle">${label}</text>`;
  let xAxis: string;
  if (!folds.length || t1 - t0 <= 36 * 3_600_000) {
    // Clock ticks; on a folded day-or-so axis, none from inside a fold.
    const shown = (t1 - t0) - folds.reduce((a, f) => a + f.to - f.from, 0);
    xAxis = xTicks(t0, t1, shown)
      .filter((t) => !folds.some((f) => t > f.from && t < f.to))
      .map((t) => tick(t, fmtTick(t, t1 - t0))).join("");
  } else {
    // A folded axis has no midnights to tick. Each run of days between
    // folds is named instead, under its middle, as far apart as fits.
    const runs: [number, number][] = [];
    let start = t0;
    for (const f of folds) { runs.push([start, f.from]); start = f.to; }
    runs.push([start, t1]);
    // Widest runs first, so a full day keeps its name over a lone report
    // heard in the middle of a long silence next to it.
    const placed: { at: number; label: string; t: number }[] = [];
    for (const [a, b] of [...runs].sort((p, q) => (x(q[1]) - x(q[0])) - (x(p[1]) - x(p[0])))) {
      const mid = (a + b) / 2;
      const label = fmtLocalDay(new Date(mid));
      if (placed.some((l) => Math.abs(l.at - x(mid)) < 58 || l.label === label)) continue;
      placed.push({ at: x(mid), label, t: mid });
    }
    xAxis = placed.map((l) => tick(l.t, l.label, false)).join("");
  }
  // The folds themselves: a dotted line down the middle of each band, and
  // the length of any silence longer than a night above it.
  const breaks = folds.map((f) => {
    const bx = ((x(f.from) + x(f.to)) / 2).toFixed(1);
    const long = f.to - f.from >= LONG_FOLD_MS
      ? `<text class="chart-break-label" x="${bx}" y="${M.top - 4}"` +
        ` text-anchor="middle">${fmtDuration(f.to - f.from)}</text>`
      : "";
    return `<line class="chart-break" x1="${bx}" x2="${bx}" y1="${M.top}"` +
      ` y2="${H - M.bottom}"/>${long}`;
  }).join("");

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
      ${grid}${xAxis}${breaks}${paths}${dots}
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
    // Nearest on screen, not in time: on a folded axis those differ.
    const xAt = (ev.clientX - rect.left) / rect.width * W;
    let best = values[0]!;
    for (const p of values) {
      if (Math.abs(x(p.t) - xAt) < Math.abs(x(best.t) - xAt)) best = p;
    }
    cursor.setAttribute("cx", String(x(best.t)));
    cursor.setAttribute("cy", String(y(best.v)));
    cursor.setAttribute("opacity", "1");
    tooltip.hidden = false;
    tooltip.textContent = `${fmtLocal(new Date(best.t))} · ` +
      `${fmtValue(best.v, decimals)} ${spec.unit}`;
    const px = (x(best.t) / W) * rect.width;
    tooltip.style.left = `${Math.min(Math.max(px, 60), rect.width - 60)}px`;
  });
  hover.addEventListener("mouseleave", () => {
    cursor.setAttribute("opacity", "0");
    tooltip.hidden = true;
  });
}
