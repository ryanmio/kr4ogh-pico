/** The selectable metrics: what a stat card selects, what the map colors
 * the spots by, and what the bottom panel charts. One definition each, so
 * the card, the map legend, the color ramp and the chart can never disagree
 * about what "speed" means.
 *
 * Journey is a metric too, colored by time: the fade from grey to bright
 * shows which way the balloon went, which is the first thing anyone asks of
 * a track. */

import { fmtUtcShort, parseUtc } from "./format";
import * as u from "./units";
import type { Units } from "./units";
import type { TrackPoint } from "./types";

export type MetricKey =
  | "journey" | "altitude" | "speed" | "voltage" | "temperature" | "receivers";

export interface Metric {
  key: MetricKey;
  /** Card and panel title. */
  label: string;
  /** Low-to-high color ramp for the map spots and the legend bar. */
  ramp: [string, string, string];
  /** Accent for the card icon and the panel chart; lives on the ramp. */
  color: string;
  /** The raw comparable value a spot is colored by. Journey uses time. */
  raw(p: TrackPoint): number;
  /** A raw value formatted for the legend ends. */
  fmt(raw: number, units: Units): string;
}

export const METRICS: Record<MetricKey, Metric> = {
  journey: {
    key: "journey",
    label: "Journey",
    ramp: ["#64748b", "#38bdf8", "#f8fafc"],
    color: "#38bdf8",
    raw: (p) => parseUtc(p.utc).getTime(),
    fmt: (raw) => fmtUtcShort(new Date(raw)),
  },
  altitude: {
    key: "altitude",
    label: "Altitude",
    ramp: ["#3b82f6", "#22d3ee", "#fde047"],
    color: "#7dd3fc",
    raw: (p) => p.altitude_m,
    fmt: (raw, units) => u.altitude(raw, units).text,
  },
  speed: {
    key: "speed",
    label: "Ground speed",
    ramp: ["#a78bfa", "#f472b6", "#fb923c"],
    color: "#f472b6",
    raw: (p) => p.speed_kt,
    fmt: (raw, units) => u.speed(raw, units).text,
  },
  voltage: {
    key: "voltage",
    label: "Voltage",
    ramp: ["#f87171", "#facc15", "#34d399"],
    color: "#34d399",
    raw: (p) => p.voltage_v,
    fmt: (raw) => `${raw.toFixed(2)} V`,
  },
  temperature: {
    key: "temperature",
    label: "Tracker temp",
    ramp: ["#60a5fa", "#c084fc", "#fb7185"],
    color: "#fb7185",
    raw: (p) => p.temperature_c,
    fmt: (raw, units) => u.temperature(raw, units).text,
  },
  receivers: {
    key: "receivers",
    label: "Receivers",
    ramp: ["#64748b", "#a78bfa", "#f0abfc"],
    color: "#a78bfa",
    raw: (p) => p.rx_station_count,
    fmt: (raw) => `${Math.round(raw)}`,
  },
};

export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];

export function isMetricKey(v: unknown): v is MetricKey {
  return typeof v === "string" && v in METRICS;
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Interpolate a ramp at f in [0, 1]. */
export function rampColor(
  ramp: [string, string, string], f: number,
): string {
  const clamped = Number.isFinite(f) ? Math.min(Math.max(f, 0), 1) : 0.5;
  const pos = clamped * (ramp.length - 1);
  const i = Math.min(Math.floor(pos), ramp.length - 2);
  const k = pos - i;
  const a = hexRgb(ramp[i]!);
  const b = hexRgb(ramp[i + 1]!);
  const mix = a.map((c, ch) => Math.round(c + (b[ch]! - c) * k));
  return `rgb(${mix.join(",")})`;
}

/** CSS gradient for a legend bar. */
export function rampGradient(ramp: [string, string, string]): string {
  return `linear-gradient(90deg, ${ramp.join(", ")})`;
}
