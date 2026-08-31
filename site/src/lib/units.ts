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
  distance: (km: number, u: Units) => (u === "imperial" ? km * KM_TO_MI : km),
  temperature: (c: number, u: Units) => (u === "imperial" ? c * 9 / 5 + 32 : c),
};

const STORAGE_KEY = "kr4ogh-units";

/** The query parameter that pins units for one link: `?u=i`, `?u=m`. The
 * long forms are accepted too, so a hand-typed `?u=imperial` works. */
export const URL_PARAM = "u";

/** Read units out of a query string, or null when it does not ask for any.
 *
 * Takes the search string rather than reading `location` so it stays pure
 * and testable, and so a caller can parse a link it has not navigated to.
 * An unrecognised value is null, not an error: a share link with a typo in
 * it should still show the flight.
 */
export function unitsFromSearch(search: string): Units | null {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get(URL_PARAM);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (v === "i" || v === "imperial") return "imperial";
  if (v === "m" || v === "metric") return "metric";
  return null;
}

/** Units for a page load: the link wins, then the browser's memory, then
 * metric.
 *
 * The link has to outrank stored preference or sharing does not work -- the
 * recipient most likely has a stored preference of their own, and it would
 * silently override the units the sender chose. It does not write through to
 * storage, though: following someone else's link is not the reader choosing
 * a default, and it must not quietly rewrite one they already set.
 */
export function resolveUnits(search: string, fallback: Units = "metric"): Units {
  return unitsFromSearch(search) ?? loadUnits(fallback);
}

/** The same page with its units pinned, for the address bar. Preserves every
 * other parameter and the hash so a deep link survives a unit toggle. */
export function urlWithUnits(href: string, units: Units): string {
  const url = new URL(href);
  url.searchParams.set(URL_PARAM, units === "imperial" ? "i" : "m");
  return url.toString();
}

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
