/** Shared shapes. TrackPoint is one fix as tool/picolog/export_site.py writes
 * it to src/data/tracks/; FlightMeta the flight header fields. The same types
 * serve both paths — the track committed for a flight, and rows decoded in
 * the browser from wspr.live. */

export interface TrackPoint {
  utc: string; // ISO 8601, always UTC
  grid6: string;
  lat: number;
  lon: number;
  altitude_m: number;
  /** Ground speed exactly as the tracker sent it. The field tops out at 82
   * knots and Traquito clamps there, so 82 means "82 or faster"; see
   * lib/speed.ts, which is where anything displaying a speed should go. */
  speed_kt: number;
  /** Ground speed derived from distance flown, present only on the fixes
   * where `speed_kt` saturated. Never stored: lib/speed.ts recomputes it
   * over the whole track whenever the track changes. */
  speed_kt_est?: number;
  /** How `speed_kt_est` was arrived at: measured from the track, or held at
   * the field's ceiling because no baseline was usable. */
  speed_source?: "derived" | "floor";
  voltage_v: number;
  temperature_c: number;
  gps_valid: boolean;
  rx_station_count: number;
  /** From the BME280 on a Petrel tracker, sent as extended telemetry in
   * slot 3 and paired to the fix by the same fingerprint. Present together,
   * and only on fixes whose cycle carried a decodable reading; a stock
   * tracker's track never has them. The temperature is the board's, a few
   * degrees above the die, not the air's. */
  pressure_hpa?: number;
  board_temp_c?: number;
  humidity_pct?: number;
}

/** A slot where only the Regular message was heard: the callsign, a 4-char
 * grid square and the power, but no Telemetry message any station could pair
 * with it. The position is the centre of a 1 deg x 2 deg box, so it is known
 * to about 80 km rather than 4, and nothing else about the fix is known at
 * all. The map draws these as ghosts beside the track; they never join the
 * line and never feed the stats. See docs/partial-spots.md. */
export interface GhostPoint {
  utc: string;
  grid4: string;
  lat: number;
  lon: number;
  rx_station_count: number;
}

export interface FlightMeta {
  flight_id: string;
  callsign: string;
  band: string;
  channel: number;
  /** false parks a flight: off the site, not pulled. */
  active?: boolean;
  launch_utc: string | null;
  /** When the flight was last heard, or declared over. Nothing after it
   * belongs to this flight: it is what keeps two flights on one channel
   * apart. Null while the flight is open-ended. */
  end_utc: string | null;
  launch_lat: number | null;
  launch_lon: number | null;
  status: "live" | "closed";
  close_reason: string | null;
  /** Metres the balloon is expected to float at, from flights.toml. It is
   * what lets the forecast model the climb (lib/forecast.ts); without it
   * the line can only float at the altitude last reported. */
  float_m?: number | null;
  /** Build details for the Tracker panel, label -> value, in the order
   * written in flights.toml. */
  tracker?: Record<string, string>;
  /** The sensor the tracker carries, or absent for a stock tracker. With
   * "bme280" the slot-3 message is fetched and decoded onto each fix, and
   * the Air pressure card appears once there is a reading to show. */
  sensor?: "bme280" | null;
}

/** Another flight drawn on the same map for comparison (lib/overlay.ts):
 * its track and ghosts, and the flight it is, for the name on its beacon. */
export interface OverlayTrack {
  meta: FlightMeta;
  track: TrackPoint[];
  ghosts: GhostPoint[];
}

/** The [site] table of flights.toml, with the deploy-time fallbacks
 * resolved (lib/config.ts). */
export interface SiteConfig {
  callsign: string;
  /** The flight_id the home page shows when the address names none, or
   * null to let lib/flights.ts choose. */
  featured: string | null;
  /** Absolute origin the site is served from, or null when nothing knows
   * it; share cards need it. */
  url: string | null;
  /** The "Source & data" link. */
  repo: string;
}
