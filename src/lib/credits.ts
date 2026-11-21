/** The map's credits on a phone. They are a line and a half of small print
 * across the foot of a narrow map, where the color key and the weather
 * switch also sit, and they ran over both. On a phone they fold behind an
 * (i) in the corner that opens them, as MapLibre's own compact attribution
 * does on small maps; a desktop shows them as always (CSS decides, at the
 * same breakpoint as the phone layout).
 *
 * The button sits beside the credits in their corner, not inside them:
 * Leaflet rewrites the credits' contents whenever a layer comes or goes,
 * which would take a button inside with it. */
export function foldCredits(credits: HTMLElement | null | undefined): {
  button: HTMLButtonElement; close: () => void;
} | null {
  const corner = credits?.parentElement;
  if (!corner) return null;
  corner.classList.add("credits-fold");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "credits-btn";
  button.setAttribute("aria-label", "Map credits");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M8 7.2v4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    <circle cx="8" cy="4.6" r="1" fill="currentColor"/></svg>`;
  const set = (open: boolean) => {
    corner.classList.toggle("credits-open", open);
    button.setAttribute("aria-expanded", String(open));
  };
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    set(!corner.classList.contains("credits-open"));
  });
  corner.appendChild(button);
  return { button, close: () => set(false) };
}
