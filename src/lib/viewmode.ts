/** Flat map or globe, as a shareable, remembered choice.
 *
 * Same three-way rule as the units and the weather layer, for the same
 * reasons: a `?v=g` link arrives showing the globe its sender was looking
 * at, the browser remembers the reader's own pick, and following someone
 * else's link never rewrites that pick. The default is the flat map, which
 * is the one with the per-point detail. */

export type ViewMode = "flat" | "globe";

const STORAGE_KEY = "kr4ogh-view";

export function isViewMode(v: unknown): v is ViewMode {
  return v === "flat" || v === "globe";
}

/** The query parameter that pins the view for one link: `?v=g` for the
 * globe, `?v=f` for the flat map. The long forms are accepted too. */
export const URL_PARAM = "v";

const FROM_URL: Record<string, ViewMode> = {
  g: "globe", globe: "globe",
  f: "flat", flat: "flat", map: "flat",
};

const TO_URL: Record<ViewMode, string> = { globe: "g", flat: "f" };

/** Read the view out of a query string, or null when it does not ask for
 * one. Pure, like weatherFromSearch, and forgiving for the same reason: a
 * share link with a typo in it should still show the flight. */
export function viewFromSearch(search: string): ViewMode | null {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get(URL_PARAM);
  } catch {
    return null;
  }
  if (raw === null) return null;
  return FROM_URL[raw.trim().toLowerCase()] ?? null;
}

/** The view for a page load: the link wins, then the browser's memory, then
 * the flat map. */
export function resolveView(
  search: string, fallback: ViewMode = "flat",
): ViewMode {
  return viewFromSearch(search) ?? loadView(fallback);
}

/** The same page with the view pinned, for the address bar. Preserves every
 * other parameter and the hash, so it composes with `?u=`, `?w=` and `?p=`. */
export function urlWithView(href: string, mode: ViewMode): string {
  const url = new URL(href);
  url.searchParams.set(URL_PARAM, TO_URL[mode]);
  return url.toString();
}

/** The reader's choice, remembered per browser; guarded like the units. */
export function loadView(fallback: ViewMode = "flat"): ViewMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isViewMode(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function saveView(mode: ViewMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* the view still switches; the choice just is not remembered */
  }
}
