/** Which detail panel is open, as a shareable thing.
 *
 * A link to this page should show what the sender was looking at, and half
 * of what they were looking at is the panel: the speed chart, the signal
 * numbers, the telemetry table. `?p=speed` opens the speed panel on
 * arrival; a link with no `p` at all opens nothing, which is also what the
 * page does on its own.
 *
 * Unlike the units and the weather layer there is nothing remembered here:
 * an open panel is where the reader is right now, not a preference, and a
 * page that reopened yesterday's chart every visit would be wrong. So the
 * link is the only input, and "no parameter" and "nothing open" are the
 * same state -- which is why closing the panel drops the parameter rather
 * than writing an emptiness into it.
 */

import { isMetricKey, type MetricKey } from "./metrics";

/** Everything the bottom panel can show: a metric's chart, or one of the
 * fixed panels behind the status card, the tracker card and the top-bar
 * chips. */
export type PanelKind = MetricKey | "status" | "tracker" | "data" | "about";

const FIXED = ["status", "tracker", "data", "about"] as const;

export function isPanelKind(v: unknown): v is PanelKind {
  return isMetricKey(v) || (FIXED as readonly unknown[]).includes(v);
}

/** The query parameter that opens a panel for one link: `?p=speed`,
 * `?p=data`, `?p=none`. Values are the panel's own name, so a shared link
 * says what it does. */
export const URL_PARAM = "p";

/** Names accepted in a link that the panel is not called internally: the
 * card's visible label, and the several ways of writing "closed". */
const ALIASES: Record<string, PanelKind | null> = {
  signal: "status",
  telemetry: "data",
  none: null, n: null, off: null, closed: null,
};

/** Read the open panel out of a query string: null for a link that asks for
 * none, and for one that asks for nothing at all.
 *
 * Takes the search string rather than reading `location` so it stays pure
 * and testable. An unrecognised value is null, not an error: a share link
 * with a typo in it should still show the flight.
 */
export function panelFromSearch(search: string): PanelKind | null {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get(URL_PARAM);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (v in ALIASES) return ALIASES[v] ?? null;
  return isPanelKind(v) ? v : null;
}

/** The same page with the open panel pinned, for the address bar. Preserves
 * every other parameter and the hash, so it composes with `?u=` and `?w=`.
 * Closing takes the parameter back out, leaving the plain URL the page
 * started with. */
export function urlWithPanel(href: string, panel: PanelKind | null): string {
  const url = new URL(href);
  if (panel === null) url.searchParams.delete(URL_PARAM);
  else url.searchParams.set(URL_PARAM, panel);
  return url.toString();
}
