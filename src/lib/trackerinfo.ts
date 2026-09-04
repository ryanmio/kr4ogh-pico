/** Hand-written build details for each flight's tracker, shown in the
 * Tracker panel. This is the story the telemetry cannot tell: what is
 * actually hanging under the balloon and why it behaves the way it does.
 * Facts only, no prose: anything a pico flier would already assume of a
 * stock Traquito build goes unsaid. Keyed by flight id; a flight without an
 * entry gets an honest shrug. */

function mini(label: string, value: string): string {
  return `<div class="fv-mini"><span>${label}</span><b>${value}</b></div>`;
}

const F1B = `<div class="fv-tracker">
  <div class="fv-minis">
    ${mini("Hardware", "Traquito Jetpack (RP2040)")}
    ${mini("Mass as flown", "17.73 g")}
    ${mini("Power", "solar only — no battery")}
    ${mini("Transmit power", "20 mW")}
    ${mini("Antenna", "20 m half-wave dipole")}
  </div>
  <div class="fv-minis">
    ${mini("Balloon", "CYMYLAR 60&Prime; superpressure")}
    ${mini("Free lift", "5.97 g of helium")}
    ${mini("Float", "10,660 m ± 60 m")}
    ${mini("Launched", "2026-08-30 12:51 UTC · Summit Point, WV")}
  </div>
  <div class="fv-minis">
    ${mini("Mode", "WSPR + U4B telemetry")}
    ${mini("Frequency", "14.097060 MHz (20 m)")}
    ${mini("Channel", "348")}
    ${mini("Schedule", "every 10 min from :04")}
  </div>
</div>`;

const DETAILS: Record<string, string> = { F1B };

export function trackerDetailsHtml(flightId: string): string {
  return DETAILS[flightId] ??
    '<p class="empty-note">No build details recorded for this flight.</p>';
}
