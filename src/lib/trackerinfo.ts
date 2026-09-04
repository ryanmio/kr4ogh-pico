/** The Tracker panel: hand-written build details from flights.toml, the
 * story the telemetry cannot tell -- what is actually hanging under the
 * balloon and why it behaves the way it does. Label and value, in the order
 * they were written ([flights.tracker]); facts only, no prose. A flight
 * without a table gets an honest shrug. */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function trackerDetailsHtml(tracker: Record<string, string> | undefined): string {
  const entries = Object.entries(tracker ?? {});
  if (!entries.length) {
    return '<p class="empty-note">No build details recorded for this flight.</p>';
  }
  const minis = entries.map(([label, value]) =>
    `<div class="fv-mini"><span>${esc(label)}</span><b>${esc(value)}</b></div>`);
  return `<div class="fv-tracker"><div class="fv-minis">${minis.join("")}</div></div>`;
}
