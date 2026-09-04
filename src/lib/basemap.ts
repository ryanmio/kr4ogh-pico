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

export interface Region {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** The opening view: the whole track, plus room around where the balloon is
 * now. Latitudes and (unwrapped) longitudes arrive in track order, so the
 * last entry of each is the balloon. */
export function fitRegion(lats: number[], lons: number[]): Region {
  let west = Math.min(...lons);
  let east = Math.max(...lons);
  let south = Math.min(...lats);
  let north = Math.max(...lats);
  const padX = (east - west) * FIT_PAD;
  const padY = (north - south) * FIT_PAD;
  west -= padX; east += padX; south -= padY; north += padY;
  const span = Math.max(east - west, north - south);
  const r = Math.min(POS_ROOM * span, POS_ROOM_MAX_DEG);
  const lat = lats[lats.length - 1]!;
  const lon = lons[lons.length - 1]!;
  return {
    west: Math.min(west, lon - r),
    east: Math.max(east, lon + r),
    south: Math.min(south, lat - r),
    north: Math.max(north, lat + r),
  };
}
