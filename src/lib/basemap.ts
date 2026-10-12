/** What the flat map and the globe share: which tiles the world is drawn
 * from, and the shape of the opening view. The flat map is Leaflet
 * (map.ts); the globe is MapLibre (globe.ts), loaded only when a reader
 * asks for it. Everything here is plain numbers and strings, so neither
 * renderer drags the other's library into its bundle. */

// Keyless satellite basemap. The dark canvas basemap that was here first
// made land and ocean nearly the same shade of grey, which for a balloon
// site is the one distinction the map exists to show. Esri's imagery needs
// no key, and coastlines, mountains and open water read at a glance; a
// labels layer on top names the places the balloon is drifting past.
export const TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/" +
  "MapServer/tile/{z}/{y}/{x}";
export const LABEL_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/" +
  "World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
export const TILE_ATTRIBUTION =
  'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, ' +
  "Earthstar Geographics";

/** Shift each longitude by ±360 as needed so consecutive points never jump
 * more than 180°. */
export function unwrapLons(track: { lon: number }[]): number[] {
  const lons: number[] = [];
  let offset = 0;
  for (let i = 0; i < track.length; i++) {
    const lon = track[i]!.lon;
    if (i > 0) {
      const prev = track[i - 1]!.lon;
      if (lon - prev > 180) offset -= 360;
      if (lon - prev < -180) offset += 360;
    }
    lons.push(lon + offset);
  }
  return lons;
}

/** Longest piece of a line, in degrees of arc, drawn as a straight segment. */
const ARC_STEP_DEG = 1;

/** A line through [lon, lat] points (longitudes unwrapped) that follows the
 * great circle between each pair instead of the straight line on the map.
 *
 * Fixes a few minutes apart are already as good as straight. The pair that
 * matters is the overnight one: the tracker is silent from dusk to dawn,
 * the two fixes either side can be a thousand kilometres apart, and on
 * Mercator a straight line between them is not a path anything takes. The
 * great circle is the shortest way across, the least it is possible to
 * claim about the night, so the line is bent along it and no further. The
 * globe needs it too: MapLibre lays a segment straight in Mercator before
 * wrapping it on the sphere. */
export function greatCircleLine(pts: number[][]): number[][] {
  const rad = Math.PI / 180;
  const out: number[][] = [];
  for (let i = 0; i < pts.length; i++) {
    const [lon1, lat1] = pts[i]!;
    if (i > 0) {
      const [lon0, lat0] = pts[i - 1]!;
      const a = unitVector(lon0! * rad, lat0! * rad);
      const b = unitVector(lon1! * rad, lat1! * rad);
      const d = Math.acos(Math.min(1, Math.max(-1,
        a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
      const n = Math.ceil(d / rad / ARC_STEP_DEG);
      // Antipodes have no single great circle; they never occur in a track.
      if (n > 1 && Math.sin(d) > 1e-9) {
        let prevLon = lon0!;
        for (let k = 1; k < n; k++) {
          const f = k / n;
          const s0 = Math.sin((1 - f) * d) / Math.sin(d);
          const s1 = Math.sin(f * d) / Math.sin(d);
          const x = s0 * a[0] + s1 * b[0];
          const y = s0 * a[1] + s1 * b[1];
          const z = s0 * a[2] + s1 * b[2];
          const raw = Math.atan2(y, x) / rad;
          // Kept next to the point before, so the arc stays on the same
          // unwrapped world as its ends.
          const lon = raw + 360 * Math.round((prevLon - raw) / 360);
          out.push([lon, Math.atan2(z, Math.hypot(x, y)) / rad]);
          prevLon = lon;
        }
      }
    }
    out.push([lon1!, lat1!]);
  }
  return out;
}

function unitVector(lon: number, lat: number): [number, number, number] {
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

// Fraction of the track's span added as breathing room around it.
const FIT_PAD = 0.06;

/** Room kept clear on every side of the current position, as a fraction of
 * the track's own span, capped at something like the width of a weather
 * system.
 *
 * Fitting the track alone puts the balloon hard against the frame, because
 * the newest fix is by definition the far end of the line. What is in front
 * of it is then off the map entirely -- which is exactly the half a reader
 * wants, and with the weather layer on it means the storm being flown into
 * is the one thing not on screen. The whole flight still fits; there is just
 * air around the balloon. */
const POS_ROOM = 0.25;
const POS_ROOM_MAX_DEG = 12;

/** Past this many degrees of longitude the whole flight stops being a
 * useful opening view: it is most of the world at a zoom where the balloon
 * is a speck, and once it laps the planet there is no box that holds it.
 * The view then centres on the balloon instead, wide enough to show the
 * weather system it is in and the ocean ahead of it. */
const MAX_FIT_DEG = 180;
const FOCUS_LON_DEG = 120;
const FOCUS_LAT_DEG = 60;

export interface Region {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** The opening view: the whole track, plus room around where the balloon is
 * now, or just a wide view around the balloon once the track is too wide
 * for that (MAX_FIT_DEG). Latitudes and (unwrapped) longitudes arrive in
 * track order, so the last entry of each is the balloon. */
export function fitRegion(lats: number[], lons: number[]): Region {
  let west = Math.min(...lons);
  let east = Math.max(...lons);
  let south = Math.min(...lats);
  let north = Math.max(...lats);
  const lat = lats[lats.length - 1]!;
  const lon = lons[lons.length - 1]!;
  if (east - west > MAX_FIT_DEG) {
    const midLat = Math.max(-80 + FOCUS_LAT_DEG / 2, Math.min(80 - FOCUS_LAT_DEG / 2, lat));
    return {
      west: lon - FOCUS_LON_DEG / 2,
      east: lon + FOCUS_LON_DEG / 2,
      south: midLat - FOCUS_LAT_DEG / 2,
      north: midLat + FOCUS_LAT_DEG / 2,
    };
  }
  const padX = (east - west) * FIT_PAD;
  const padY = (north - south) * FIT_PAD;
  west -= padX; east += padX; south -= padY; north += padY;
  const span = Math.max(east - west, north - south);
  const r = Math.min(POS_ROOM * span, POS_ROOM_MAX_DEG);
  return {
    west: Math.min(west, lon - r),
    east: Math.max(east, lon + r),
    south: Math.min(south, lat - r),
    north: Math.max(north, lat + r),
  };
}
