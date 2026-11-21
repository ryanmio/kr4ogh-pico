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

/** Rows a phone shows before "More details": the build itself, then mass
 * and power. A desktop panel has the columns to show every row. */
const PHONE_ROWS = 5;

export function trackerDetailsHtml(
  tracker: Record<string, string> | undefined,
  opts: { more: string; open: boolean },
): string {
  const entries = Object.entries(tracker ?? {});
  if (!entries.length) {
    return '<p class="empty-note">No build details recorded for this flight.</p>';
  }
  // A spec sheet: a row per fact, label beside value, read down each
  // column. These are a dozen short phrases, not three headline numbers,
  // so they are set as text, not in the big stat style the metric panels
  // lead with.
  const rows = entries.map(([label, value], i) =>
    `<div class="fv-spec-row${i >= PHONE_ROWS ? " fv-spec-extra" : ""}"><dt>${
      esc(label)}</dt><dd>${valueHtml(value)}</dd></div>`);
  const more = entries.length > PHONE_ROWS
    ? `<div class="fv-spec-more">${opts.more}</div>` : "";
  return `<dl class="fv-spec${opts.open ? " is-open" : ""}">${rows.join("")}</dl>${more}`;
}
