/** The Tracker panel: hand-written build details from flights.toml, the
 * story the telemetry cannot tell -- what is actually hanging under the
 * balloon and why it behaves the way it does. Label and value, in the order
 * they were written ([flights.tracker]); facts only, no prose. A flight
 * without a table gets an honest shrug. A value may carry a link written
 * [text](https://...); nothing else in it is markup. */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

function valueHtml(value: string): string {
  let html = "";
  let at = 0;
  for (const m of value.matchAll(LINK)) {
    html += esc(value.slice(at, m.index));
    html += `<a href="${esc(m[2])}" target="_blank" rel="noopener">${esc(m[1])}</a>`;
    at = m.index! + m[0].length;
  }
  return html + esc(value.slice(at));
}

export function trackerDetailsHtml(tracker: Record<string, string> | undefined): string {
  const entries = Object.entries(tracker ?? {});
  if (!entries.length) {
    return '<p class="empty-note">No build details recorded for this flight.</p>';
  }
  const minis = entries.map(([label, value]) =>
    `<div class="fv-mini"><span>${esc(label)}</span><b>${valueHtml(value)}</b></div>`);
  return `<div class="fv-tracker"><div class="fv-minis">${minis.join("")}</div></div>`;
}
