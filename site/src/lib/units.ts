/** Unit system for everything the reader sees.
 *
 * The stored track is always metric and always knots, because that is what
 * the telemetry encodes. Conversion happens at the point of display only, so
 * there is one representation of the data and no chance of a converted value
 * being written back.
 *
 * Knots are not used in the UI either way: a reader who is not a pilot or a
 * sailor does not think in them. Metric shows km/h, imperial shows mph.
 */

export type Units = "metric" | "imperial";

export const M_TO_FT = 3.280839895;
export const KM_TO_MI = 0.621371192;
export const KT_TO_KMH = 1.852;
export const KT_TO_MPH = 1.150779448;

export function isUnits(v: unknown): v is Units {
  return v === "metric" || v === "imperial";
}

export interface Measure {
  value: number;
  unit: string;
  /** Value formatted with the right number of decimals for its magnitude. */
  text: string;
}

function measure(value: number, unit: string, decimals: number): Measure {
  const rounded = Number(value.toFixed(decimals));
  return {
    value: rounded,
    unit,
    text: `${rounded.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })} ${unit}`,
  };
}

export function altitude(m: number, units: Units): Measure {
  return units === "imperial"
    ? measure(m * M_TO_FT, "ft", 0)
    : measure(m, "m", 0);
}

export function distance(km: number, units: Units): Measure {
  return units === "imperial"
    ? measure(km * KM_TO_MI, "mi", 0)
    : measure(km, "km", 0);
}

export function speed(kt: number, units: Units): Measure {
  return units === "imperial"
    ? measure(kt * KT_TO_MPH, "mph", 0)
    : measure(kt * KT_TO_KMH, "km/h", 0);
}

export function temperature(c: number, units: Units): Measure {
  return units === "imperial"
    ? measure(c * 9 / 5 + 32, "°F", 0)
    : measure(c, "°C", 0);
}

/** Unit label alone, for a chart axis where the numbers carry themselves. */
export const unitLabels = (units: Units) => ({
  altitude: units === "imperial" ? "ft" : "m",
  speed: units === "imperial" ? "mph" : "km/h",
  distance: units === "imperial" ? "mi" : "km",
  temperature: units === "imperial" ? "°F" : "°C",
});

/** Convert a raw stored value into the displayed number, for charts. */
export const convert = {
  altitude: (m: number, u: Units) => (u === "imperial" ? m * M_TO_FT : m),
  speed: (kt: number, u: Units) => kt * (u === "imperial" ? KT_TO_MPH : KT_TO_KMH),
  temperature: (c: number, u: Units) => (u === "imperial" ? c * 9 / 5 + 32 : c),
};

const STORAGE_KEY = "kr4ogh-units";

/** The reader's choice, remembered per browser. Storage can throw (private
 * windows, blocked site data), so every access is guarded and falls back to
 * the default rather than breaking the page. */
export function loadUnits(fallback: Units = "metric"): Units {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isUnits(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function saveUnits(units: Units): void {
  try {
    localStorage.setItem(STORAGE_KEY, units);
  } catch {
    /* not worth surfacing: the page works, the choice just is not remembered */
  }
}
