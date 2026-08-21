/** Shared shapes. TrackPoint matches the track.json entries specified in
 * docs/architecture.md; FlightMeta matches the Supabase `flights` row and the
 * track.json header fields. The same types serve both data paths — archived
 * flights from git, live flights from the Supabase cache. */

export interface TrackPoint {
  utc: string; // ISO 8601, always UTC
  grid6: string;
  lat: number;
  lon: number;
  altitude_m: number;
  speed_kt: number;
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
