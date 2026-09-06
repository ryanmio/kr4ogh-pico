/** Which flight the home page shows, as a shareable thing.
 *
 * The home page is one flight. When more than one is on the site, the
 * address says which: `/?feature=F2A`. No parameter means the featured
 * flight (lib/flights.ts), so the plain address is always the one the
 * operator wants seen first, and a link with the parameter shows the
 * sender's flight. Nothing is remembered: which flight a reader last
 * looked at is not a preference.
 *
 * `/live/<flight_id>/` is the same view at a permalink; this parameter is
 * for the home page, where the flights are switched in place.
 */

export const URL_PARAM = "feature";

/** The flight_id a query string asks for, or null for none. Ids are
 * matched case-insensitively by the caller: a link typed by hand should
 * still land. */
export function featureFromSearch(search: string): string | null {
  try {
    const raw = new URLSearchParams(search).get(URL_PARAM);
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

/** The same page with the flight pinned, for the address bar and the
 * "Next flight" button. Preserves every other parameter and the hash, so
 * it composes with `?u=`, `?w=`, `?v=` and `?p=`. */
export function urlWithFeature(href: string, flightId: string | null): string {
  const url = new URL(href);
  if (flightId === null) url.searchParams.delete(URL_PARAM);
  else url.searchParams.set(URL_PARAM, flightId);
  return url.toString();
}
