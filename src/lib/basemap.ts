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
/** Finer for a bend: a straight arc hides its facets, a curve shows them. */
const BEND_STEP_DEG = 0.25;

type Vec3 = [number, number, number];
const RAD = Math.PI / 180;
const EARTH_KM = 6371;

/** A line through [lon, lat] points (longitudes unwrapped) that follows the
 * great circle between each pair instead of the straight line on the map.
 *
 * Points a few minutes apart are already as good as straight. The pair
 * that matters is far apart: on Mercator a straight line between two points
 * a thousand kilometres apart is not a path anything takes, and the globe
 * needs the bend too, since MapLibre lays a segment straight in Mercator
 * before wrapping it on the sphere. This is the line for the dashed tail of
 * ghosts, where nothing better than the shortest way across is known. The
 * track itself goes through flightLine, which knows when each fix was. */
export function greatCircleLine(pts: number[][]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < pts.length; i++) {
    const [lon1, lat1] = pts[i]!;
    if (i > 0) {
      const [lon0, lat0] = pts[i - 1]!;
      sampleArc(out, unitVector(lon0!, lat0!), unitVector(lon1!, lat1!), lon0!);
    }
    out.push([lon1!, lat1!]);
  }
  return out;
}

/** A silence this long is a hole in the track rather than a missed slot or
 * two. Reports come every ten minutes in sunlight; the tracker is quiet
 * from dusk to dawn, and now and then for an afternoon over an ocean no
 * station is listening to. Across a hole the path is unknown and any line
 * is a guess; flightLine draws the best one. */
const BEND_GAP_MS = 2 * 60 * 60 * 1000;

/** How far apart two fixes have to be before the heading between them is
 * worth anything. A 6-character grid square is about 4 km by 5 km at these
 * latitudes, so two consecutive fixes 9 km apart give a heading good to
 * perhaps 30 degrees; over 20 km it settles to within about 10. */
const HEADING_MIN_KM = 20;

export interface TimedPoint { lat: number; utc: string }

/** The track's line: [lon, lat] points through every fix, along the great
 * circle between fixes that follow one another, and bent across a long
 * silence to agree with the headings either side of it.
 *
 * The overnight gap is the one that matters. The two fixes either side of
 * it can be a thousand kilometres apart, and the great circle between them,
 * though the shortest way across, is a path the balloon very likely did not
 * take: one drifting south-east at dusk and north-east at dawn turned
 * somewhere in between, and a straight line leaves the dusk fix and arrives
 * at the dawn one at angles nothing in the track supports. So the line
 * leaves the last fix before the silence on the heading the balloon was
 * flying then, and arrives at the first fix after on the heading it was
 * flying when it reappeared: a cubic Bezier on the sphere, control points a
 * third of the way across along each heading, the usual choice for a curve
 * that is smooth without overshooting. With a heading on one side only
 * (the track starts or ends at the silence, or a second silence follows at
 * once) the curve is a quadratic, leaving on the known heading and arriving
 * however it lands; with neither it is the great circle. It is still a
 * guess -- the dusk and dawn headings are all the evidence there is -- but
 * it is the smoothest line that agrees with them.
 *
 * `lons` are the track's longitudes unwrapped (unwrapLons), in track order;
 * the fixes themselves are read only for their latitudes and times. */
export function flightLine(track: TimedPoint[], lons: number[]): number[][] {
  const out: number[][] = [];
  const ms = track.map((p) => Date.parse(p.utc));
  const at = (i: number): Vec3 => unitVector(lons[i]!, track[i]!.lat);
  for (let i = 0; i < track.length; i++) {
    if (i > 0) {
      const a = at(i - 1);
      const b = at(i);
      const d = angle(a, b);
      // Not bent across a short hop: the headings either side would be
      // mostly grid noise, and the curve would wiggle for nothing.
      const bent = ms[i]! - ms[i - 1]! >= BEND_GAP_MS && d * EARTH_KM >= 2 * HEADING_MIN_KM
        ? bend(a, b, travelTangent(at, ms, i - 1, -1), travelTangent(at, ms, i, +1))
        : null;
      if (bent) sampleCurve(out, bent, 1.5 * d, BEND_STEP_DEG, lons[i - 1]!);
      else sampleArc(out, a, b, lons[i - 1]!);
    }
    out.push([lons[i]!, track[i]!.lat]);
  }
  return out;
}

/** The way the balloon was travelling at fix i, as a unit vector tangent to
 * the sphere there, read from the fixes on the side `dir` points to (-1 the
 * ones before, +1 the ones after). The neighbour used is the nearest one
 * HEADING_MIN_KM away, so grid quantisation does not set the heading; the
 * search stops at another silence, since nothing beyond that is this
 * heading either, and settles for a nearer fix when the track runs out
 * first. Null with no fix on that side at all. */
function travelTangent(
  at: (i: number) => Vec3, ms: number[], i: number, dir: -1 | 1,
): Vec3 | null {
  const p = at(i);
  let q: Vec3 | null = null;
  for (let j = i + dir; j >= 0 && j < ms.length; j += dir) {
    if (Math.abs(ms[j]! - ms[j - dir]!) >= BEND_GAP_MS) break;
    q = at(j);
    if (angle(p, q) * EARTH_KM >= HEADING_MIN_KM) break;
  }
  if (!q) return null;
  // The part of q not along p points from p towards q within the tangent
  // plane: the way the balloon went when q is later, came from when earlier.
  const t = axpy(q, p, -dot(p, q));
  const len = Math.hypot(t[0], t[1], t[2]);
  if (len < 1e-9) return null;
  return [dir * t[0] / len, dir * t[1] / len, dir * t[2] / len];
}

/** The curve across a silence from a to b, leaving along tIn and arriving
 * along tOut where those are known, as a Bezier on the unit vectors (the
 * sampling projects it back onto the sphere; the sag beneath it is nothing
 * over the few tens of degrees a night covers). Null with neither heading,
 * when the great circle is all there is. */
function bend(
  a: Vec3, b: Vec3, tIn: Vec3 | null, tOut: Vec3 | null,
): ((f: number) => Vec3) | null {
  const d = angle(a, b);
  if (tIn && tOut) {
    const c0 = axpy(a, tIn, d / 3);
    const c1 = axpy(b, tOut, -d / 3);
    return (f) => {
      const g = 1 - f;
      return mix([g * g * g, 3 * g * g * f, 3 * g * f * f, f * f * f], [a, c0, c1, b]);
    };
  }
  if (tIn || tOut) {
    const c = tIn ? axpy(a, tIn, d / 2) : axpy(b, tOut!, -d / 2);
    return (f) => {
      const g = 1 - f;
      return mix([g * g, 2 * g * f, f * f], [a, c, b]);
    };
  }
  return null;
}

/** The great circle from a to b. Antipodes have no single great circle;
 * they never occur in a track. */
function sampleArc(out: number[][], a: Vec3, b: Vec3, prevLon: number): void {
  const d = angle(a, b);
  if (Math.sin(d) <= 1e-9) return;
  sampleCurve(out, (f) => {
    const s0 = Math.sin((1 - f) * d) / Math.sin(d);
    const s1 = Math.sin(f * d) / Math.sin(d);
    return mix([s0, s1], [a, b]);
  }, d, ARC_STEP_DEG, prevLon);
}

/** Push the points strictly between the ends of a curve over the sphere,
 * one per `stepDeg` of its length (`lengthRad`, roughly), as [lon, lat]
 * with the longitudes kept on the same unwrapped world as `prevLon`. The
 * curve need not return unit vectors: only their direction is read. */
function sampleCurve(
  out: number[][], curve: (f: number) => Vec3, lengthRad: number, stepDeg: number,
  prevLon: number,
): void {
  const n = Math.ceil(lengthRad / RAD / stepDeg);
  for (let k = 1; k < n; k++) {
    const [x, y, z] = curve(k / n);
    const raw = Math.atan2(y, x) / RAD;
    // Kept next to the point before, so the line stays on the same
    // unwrapped world as its ends.
    const lon = raw + 360 * Math.round((prevLon - raw) / 360);
    out.push([lon, Math.atan2(z, Math.hypot(x, y)) / RAD]);
    prevLon = lon;
  }
}

function unitVector(lonDeg: number, latDeg: number): Vec3 {
  const lon = lonDeg * RAD;
  const lat = latDeg * RAD;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** The angle between two unit vectors, in radians: the arc between them. */
function angle(a: Vec3, b: Vec3): number {
  return Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
}

/** a + k v. */
function axpy(a: Vec3, v: Vec3, k: number): Vec3 {
  return [a[0] + k * v[0], a[1] + k * v[1], a[2] + k * v[2]];
}

/** The weighted sum of vectors. */
function mix(w: number[], v: Vec3[]): Vec3 {
  const r: Vec3 = [0, 0, 0];
  for (let i = 0; i < w.length; i++) {
    r[0] += w[i]! * v[i]![0];
    r[1] += w[i]! * v[i]![1];
    r[2] += w[i]! * v[i]![2];
  }
  return r;
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
