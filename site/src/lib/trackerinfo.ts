/** Hand-written build details for each flight's tracker, shown in the
 * Tracker panel. This is the story the telemetry cannot tell: what is
 * actually hanging under the balloon and why it behaves the way it does.
 * Keyed by flight id; a flight without an entry gets an honest shrug. */

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
    ${mini("Balloon", "60&Prime; mylar superpressure")}
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
  <p>The envelope is superpressure: once the helium fully inflates it, its
  volume is fixed, so instead of climbing until it bursts it settles at one
  altitude and stays there. That is what makes flights of days, weeks, or
  months possible.</p>
  <p>There is no battery. The tracker wakes when the sun climbs above about
  24° and sleeps when it drops below about 21°, so it goes silent every
  night — that is normal, not a lost flight. It survived its first night
  with no measurable altitude loss.</p>
  <p>Its 20 milliwatts — a thousandth of a light bulb — reach four
  continents because volunteer amateurs run WSPR receivers around the
  clock; on a good cycle 60–75 stations hear each report. It also appears
  on the
  <a href="https://traquito.github.io/search/spots/dashboard/?band=20m&amp;channel=348&amp;callsign=KR4OGH&amp;dtGte=2026-08-30&amp;dtLte=2026-09-30">Traquito
  dashboard</a>, with a 3D globe and KML export. The payload will not be
  recovered: every unit is written off at launch.</p>
</div>`;

const DETAILS: Record<string, string> = { F1B };

export function trackerDetailsHtml(flightId: string): string {
  return DETAILS[flightId] ??
    '<p class="empty-note">No build details recorded for this flight.</p>';
}
