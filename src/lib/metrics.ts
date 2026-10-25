/** The selectable metrics: what a stat card selects, what the map colors
 * the spots by, and what the bottom panel charts. One definition each, so
 * the card, the map legend, the color ramp and the chart can never disagree
 * about what "speed" means.
 *
 * Journey is a metric too, colored by time: the fade from grey to bright
 * shows which way the balloon went, which is the first thing anyone asks of
 * a track. */

import { fmtUtcShort, parseUtc } from "./format";
import { groundSpeedKt } from "./speed";
import * as u from "./units";
import type { Units } from "./units";
import type { TrackPoint } from "./types";

export type MetricKey =
  | "journey" | "altitude" | "pressure" | "speed" | "voltage" | "temperature"
  | "receivers";

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
  /** Whether the track carries this metric at all. Left out, it always
   * does. Pressure comes from a sensor only some trackers have, so its
   * card, chart and coloring exist only on a flight that has sent a
   * reading; `raw` is NaN on a fix without one. */
  available?(track: TrackPoint[]): boolean;
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
  pressure: {
    key: "pressure",
    label: "Air pressure",
    // Low pressure is high altitude, so the ramp runs the altitude ramp's
    // way round: the warm end is near the ground.
    ramp: ["#c4b5fd", "#5eead4", "#fbbf24"],
    color: "#5eead4",
    raw: (p) => p.pressure_hpa ?? NaN,
    fmt: (raw) => `${Math.round(raw)} hPa`,
    available: (track) => track.some((p) => p.pressure_hpa !== undefined),
  },
  speed: {
    key: "speed",
    label: "Ground speed",
    ramp: ["#a78bfa", "#f472b6", "#fb923c"],
    color: "#f472b6",
    raw: (p) => groundSpeedKt(p),
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

export function isMetricKey(v: unknown): v is MetricKey {
  return typeof v === "string" && v in METRICS;
}

/** Whether a flight's track has anything to show for a metric. */
export function metricAvailable(key: MetricKey, track: TrackPoint[]): boolean {
  return METRICS[key].available?.(track) ?? true;
}

/** The newest fix that carries a sensor reading, or null when none does. */
export function lastSensorFix(track: TrackPoint[]): TrackPoint | null {
  for (let i = track.length - 1; i >= 0; i--) {
    if (track[i]!.pressure_hpa !== undefined) return track[i]!;
  }
  return null;
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
