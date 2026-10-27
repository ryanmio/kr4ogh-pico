/** Custom events for Vercel Web Analytics: who is a person, and what they do.
 *
 * A page view alone cannot tell a reader from a crawler that runs
 * JavaScript, so nothing here is sent until the page has felt a real input:
 * a trusted pointer, touch, key or wheel event, which a script calling
 * .click() or a headless renderer that only loads the page does not make.
 * That first input is itself the `Human` event, so
 *
 *   visitors on `Human`   ≈ how many people,
 *   `Engaged` by `after`  ≈ how long they stayed,
 *   everything else       ≈ what they did.
 *
 * The plan allows two properties per event (Pro), so each event carries the
 * two that answer its question and no more. Names are what the dashboard
 * lists; keep them stable, or the history splits in two.
 *
 * The site's owner is left out of all of it, page views included: see the
 * `notrack` script in layouts/Base.astro.
 */
import { track } from "@vercel/analytics";

type Data = Record<string, string | number | boolean | null>;

let human = false;
const once = new Set<string>();

/** Send `name`, but only for a page a person has touched. Anything asked
 * for before then is dropped rather than queued: the clicks that would
 * send it are themselves preceded by the pointerdown that marks the
 * page human, so only a script could get here first. */
export function act(name: string, data?: Data): void {
  if (!human) return;
  try {
    track(name, data);
  } catch {
    /* analytics is never worth breaking the page over */
  }
}

/** `act`, at most once per page load per `key` (default: the name). For
 * things a reader does continuously, like dragging the map, where the
 * question is whether they did it at all. */
export function actOnce(name: string, data?: Data, key = name): void {
  if (!human || once.has(key)) return;
  once.add(key);
  act(name, data);
}

const VISIT_KEY = "kr4ogh.seen";

/** First time this browser has been here, or back again. Per browser, not
 * per person, and lost with the site data; good enough to see whether
 * anyone returns. */
function visitKind(): "first" | "return" {
  try {
    const seen = localStorage.getItem(VISIT_KEY);
    if (!seen) localStorage.setItem(VISIT_KEY, new Date().toISOString().slice(0, 10));
    return seen ? "return" : "first";
  } catch {
    return "first";
  }
}

/** Visible time after the first input at which `Engaged` is sent. Counted
 * only while the tab is in front, so a tab left behind others does not
 * read as a reader. */
const DWELL_MARKS: [number, string][] = [[30, "30s"], [120, "2m"], [600, "10m"]];

/** Start listening. `flight` is read when each event is sent, since the
 * home page can switch flights in place. */
export function startAnalytics(flight: () => string): void {
  const INPUTS = ["pointerdown", "keydown", "wheel"];
  const onInput = (ev: Event) => {
    if (!ev.isTrusted || human) return;
    human = true;
    for (const type of INPUTS) window.removeEventListener(type, onInput, true);
    // touch, mouse or pen; a phone reader shows up as touch.
    const input = ev instanceof PointerEvent ? ev.pointerType || "mouse"
      : ev.type === "keydown" ? "key" : "wheel";
    act("Human", { input, visit: visitKind() });
    startDwell(flight);
  };
  // Capture, so the mark is set before the press it belongs to is handled
  // and the event that press sends is not dropped.
  for (const type of INPUTS) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
  }

  // Links that leave the site: where readers go next. Delegated, because
  // the About panel's links are rendered after load.
  document.addEventListener("click", (ev) => {
    const a = (ev.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || a.host === location.host) return;
    const place = a.closest(".fv-panel") ? "about" : a.closest("footer") ? "footer" : "page";
    act("Outbound", { host: a.host, place });
  }, true);
}

function startDwell(flight: () => string) {
  let seconds = 0;
  let next = 0;
  const TICK_S = 5;
  const timer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    seconds += TICK_S;
    while (next < DWELL_MARKS.length && seconds >= DWELL_MARKS[next]![0]) {
      act("Engaged", { after: DWELL_MARKS[next]![1], flight: flight() });
      next++;
    }
    if (next >= DWELL_MARKS.length) clearInterval(timer);
  }, TICK_S * 1000);
}
