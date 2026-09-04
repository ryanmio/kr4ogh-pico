/** Shared shapes. TrackPoint matches the track.json entries specified in
 * docs/architecture.md; FlightMeta the flight header fields. The same types
 * serve every path — archived flights from git, the track committed for a
 * live flight, and rows decoded in the browser from wspr.live. */

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
}

export interface FlightMeta {
  flight_id: string;
  callsign: string;
  band: string;
  channel: number;
  launch_utc: string | null;
  launch_lat: number | null;
  launch_lon: number | null;
  status: "live" | "closed";
  close_reason: string | null;
}

/** The whole track.json object. */
export interface FlightArchive extends FlightMeta {
  matcher_name: string;
  matcher_version: number;
  track: TrackPoint[];
}
