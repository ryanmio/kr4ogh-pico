/** Other flights drawn on the same map, as a shareable thing.
 *
 * The view is one flight: its cards, its panel, its beacon. When two are
 * up at once the address can put the others' tracks on the map beside it:
 * `/?feature=F2B&overlay=F2A`, or `&overlay=all` for every other flight
 * the site shows. They are context, not a second subject -- a dimmer line
 * with its own beacon and a name on it, no cards and no numbers.
 *
 * Nothing is remembered, like the panel and the feature: which flights a
 * reader was comparing is where they were, not a preference. "all" is what
 * the button writes, so the link survives the "Next flight" button
 * switching which flight is the subject.
 */

export const URL_PARAM = "overlay";

/** Spellings accepted in a link: "overlap" is the natural word for what
 * this does, and "with" reads well when typed by hand. */
const ALIASES = ["overlay", "overlap", "with"];

export type OverlayChoice = "all" | string[];

/** The overlays a query string asks for: "all", a list of flight ids, or
 * null for none. Ids are matched case-insensitively by the caller. */
export function overlaysFromSearch(search: string): OverlayChoice | null {
  let raw: string | null = null;
  try {
    const params = new URLSearchParams(search);
    for (const name of ALIASES) {
      raw = params.get(name);
      if (raw !== null) break;
    }
  } catch {
    return null;
  }
  if (raw === null) return null;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((p) => p.toLowerCase() === "all")) return "all";
  return parts;
}

/** The ids to draw beside `featured`, from what the address asked for and
 * the flights the site has. Unknown ids and the featured flight itself
 * are dropped, so a typo or a "Next flight" press cannot double a track. */
export function resolveOverlays(
  choice: OverlayChoice | null, featured: string, known: string[],
): string[] {
  if (choice === null) return [];
  const wanted = choice === "all"
    ? known
    : choice.flatMap((id) =>
      known.filter((k) => k.toLowerCase() === id.toLowerCase()));
  return [...new Set(wanted)].filter((id) => id !== featured);
}

/** The same page with the overlays pinned, for the address bar. Preserves
 * every other parameter and the hash. Null takes the parameter back out,
 * under every spelling, leaving the plain address. */
export function urlWithOverlays(href: string, choice: OverlayChoice | null): string {
  const url = new URL(href);
  for (const name of ALIASES) url.searchParams.delete(name);
  if (choice === "all") url.searchParams.set(URL_PARAM, "all");
  else if (choice && choice.length) url.searchParams.set(URL_PARAM, choice.join(","));
  return url.toString();
}
