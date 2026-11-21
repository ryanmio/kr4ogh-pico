/** What the balloon is over, by name, for the reel's "over" line.
 *
 * A film of a flight from behind the balloon shows a great deal of planet
 * and says nothing about which part. This names it: the sea or ocean
 * under the balloon, or the country, and on land any great feature it is
 * crossing as well, the Sahara or the Rocky Mountains.
 *
 * The names and outlines are src/data/places.json, cut from Natural Earth
 * by dev/gen-places.mjs. Nothing here touches a network.
 *
 * A name is only worth showing if it can be read, and a reel covers
 * ground fast: over Europe a country lasts a few frames. So the line is
 * settled over the whole film before any of it is shown (`overLine`), and
 * what it shows at each instant is the name that can be read there.
 */

/** src/data/places.json: rings are flat [x, y, x, y, ...] in twentieths
 * of a degree. */
export interface PlaceData {
  countries: [name: string, continent: string, rings: number[][]][];
  seas: [name: string, ocean: 0 | 1, rings: number[][]][];
  land: [name: string, rings: number[][]][];
}

const STEP = 20;

interface Shape {
  name: string;
  /** A country's continent. */
  group?: string;
  ocean?: boolean;
  rings: number[][];
  boxes: [number, number, number, number][];
  /** Of its bounding box, in stored units: the smaller of two shapes
   * around a point is the more particular name. */
  size: number;
}

/** The names for one point, most particular first. Any may be missing. */
export interface Named {
  /** A sea, gulf or bay; or on land a desert, range, plateau or plain. */
  feature: string | null;
  country: string | null;
  /** The continent, or the ocean. */
  wide: string | null;
}

function shape(name: string, rings: number[][]): Shape {
  let size = 0;
  const boxes = rings.map((r): [number, number, number, number] => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) {
      x0 = Math.min(x0, r[i]!); x1 = Math.max(x1, r[i]!);
      y0 = Math.min(y0, r[i + 1]!); y1 = Math.max(y1, r[i + 1]!);
    }
    size += (x1 - x0) * (y1 - y0);
    return [x0, y0, x1, y1];
  });
  return { name, rings, boxes, size };
}

function inside(s: Shape, x: number, y: number): boolean {
  for (let k = 0; k < s.rings.length; k++) {
    const b = s.boxes[k]!;
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
    const r = s.rings[k]!;
    let hit = false;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const yi = r[i + 1]!;
      const yj = r[j + 1]!;
      if ((yi > y) !== (yj > y) && x < (r[j]! - r[i]!) * (y - yi) / (yj - yi) + r[i]!) hit = !hit;
    }
    if (hit) return true;
  }
  return false;
}

/** The smallest of the shapes a point is inside. */
function smallest(shapes: Shape[], x: number, y: number): Shape | null {
  let best: Shape | null = null;
  for (const s of shapes) {
    if ((!best || s.size < best.size) && inside(s, x, y)) best = s;
  }
  return best;
}

function continent(country: Shape, lonDeg: number): string | null {
  // Natural Earth files all of Russia under Europe; east of the Urals,
  // and across the date line in Chukotka, it is Asia.
  if (country.name === "Russia") return lonDeg > 60 || lonDeg < -160 ? "Asia" : "Europe";
  // And a few islands under no continent at all.
  return /ocean|seas/i.test(country.group ?? "") ? null : country.group ?? null;
}

/** A lookup from a position to its names. */
export function placeFinder(data: PlaceData): (lonDeg: number, latDeg: number) => Named {
  const countries = data.countries.map(([name, group, rings]) => ({ ...shape(name, rings), group }));
  const seas = data.seas.filter((s) => !s[1]).map(([name, , rings]) => shape(name, rings));
  const oceans = data.seas.filter((s) => s[1]).map(([name, , rings]) => shape(name, rings));
  const land = data.land.map(([name, rings]) => shape(name, rings));
  return (lonDeg, latDeg) => {
    const x = (((lonDeg + 180) % 360 + 360) % 360 - 180) * STEP;
    const y = latDeg * STEP;
    const country = smallest(countries, x, y);
    if (country) {
      return {
        feature: smallest(land, x, y)?.name ?? null,
        country: country.name,
        wide: continent(country, lonDeg),
      };
    }
    return {
      feature: smallest(seas, x, y)?.name ?? null,
      country: null,
      wide: smallest(oceans, x, y)?.name ?? null,
    };
  };
}

/** The line on screen at one frame. */
export interface OverLine {
  /** A country, a sea or an ocean; or where no country lasts long enough,
   * the feature that spans them, the Balkan Peninsula. */
  name: string;
  /** Under it, smaller: the feature of the land being crossed, the Kazakh
   * Steppe under Kazakhstan; or under a feature, what it is in. */
  detail: string | null;
  /** Frames since this name came up, for its entrance. */
  since: number;
}

/** For each frame, how long the run of equal values around it is. */
function runLengths(v: (string | null)[]): number[] {
  const out = new Array<number>(v.length);
  for (let a = 0; a < v.length;) {
    let b = a;
    while (b < v.length && v[b] === v[a]) b++;
    out.fill(b - a, a, b);
    a = b;
  }
  return out;
}

/** The value that most of a stretch of frames has, if at least `share` of
 * them do. */
function mostly(values: (string | null)[], share: number): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [top, count] = [...counts].sort((x, y) => y[1] - x[1])[0] ?? [null, 0];
  return top && count >= share * values.length ? top : null;
}

/** The "over" line for every frame of a film, from the names at each, such
 * that no name is up for less than `min` frames.
 *
 * Where a country lasts that long, it is the name: countries are what a
 * viewer knows. Where none does but one feature spans them (the Iberian
 * Peninsula over Portugal and Spain), that is. At sea it is the sea or
 * gulf, else the ocean.
 *
 * What is left is scraps: a stretch where nothing holds for `min` frames,
 * a coast, a strait, an island, a corner of three countries. A stretch of
 * scraps long enough to read gets one name, the one most of it shares if
 * there is such a name, else whichever piece there is most of: Korea, the
 * Sea of Japan and Japan in a fifth of a second each go by as the Sea of
 * Japan. A shorter stretch joins a neighbour: one that names part of it,
 * else one of its own kind, land to land. These are the places a name stands over ground it is not strictly
 * the name of, for less than `min` frames at a time.
 *
 * The first name and the last stand however brief: where the flight began
 * and where it is now are the two places that matter most, and the first
 * is the frame a film is judged by. */
export function overLine(found: Named[], min: number): (OverLine | null)[] {
  const n = found.length;
  // The outlines are coarse, and a fjord coast can fall between the land
  // and the sea with no name at all: such a frame takes its neighbour's.
  const blank = (p: Named) => !p.feature && !p.country && !p.wide;
  const named = found.map((p, f) => {
    if (!blank(p)) return p;
    for (let d = 1; d < n; d++) {
      const near = [found[f - d], found[f + d]].find((q) => q && !blank(q));
      if (near) return near;
    }
    return p;
  });
  const features = named.map((p) => p.feature);
  const countries = named.map((p) => p.country);
  const wides = named.map((p) => p.wide);
  const lasts = { feature: runLengths(features), country: runLengths(countries), wide: runLengths(wides) };

  // What holds on its own.
  const name: (string | null)[] = named.map((p, f) => {
    if (p.country) {
      return lasts.country[f]! >= min ? p.country
        : p.feature && lasts.feature[f]! >= min ? p.feature : null;
    }
    return p.feature && lasts.feature[f]! >= min ? p.feature
      : p.wide && lasts.wide[f]! >= min ? p.wide : null;
  });

  // The scraps, a stretch at a time.
  const piece = named.map((p) => p.country ?? p.feature ?? p.wide);
  for (let a = 0; a < n;) {
    let b = a;
    while (b < n && (name[b] == null) === (name[a] == null)) b++;
    if (name[a] == null && (b - a >= min || a === 0 || b === n)) {
      const shared = mostly(features.slice(a, b), 0.7) ?? mostly(countries.slice(a, b), 0.7)
        ?? mostly(wides.slice(a, b), 0.7);
      name.fill(shared ?? mostly(piece.slice(a, b), 0), a, b);
    }
    a = b;
  }
  // Whatever is still too brief joins a neighbour: a short stretch of
  // scraps, or a name cut short by the one beside it.
  for (;;) {
    const lengths = runLengths(name);
    let at = -1;
    let least = min;
    for (let a = 0; a < n; a += lengths[a]!) {
      if (lengths[a]! < least && a > 0 && a + lengths[a]! < n) { least = lengths[a]!; at = a; }
    }
    if (at < 0) break;
    const end = at + least;
    const names = (to: string | null) => to != null && named.slice(at, end)
      .some((p) => p.feature === to || p.country === to || p.wide === to);
    const before = name[at - 1]!;
    const after = name[end]!;
    const land = (f: number) => named[f]!.country != null;
    const kin = (f: number) => land(f) === land(at + (least >> 1));
    const to = names(before) !== names(after) ? (names(before) ? before : after)
      : kin(at - 1) !== kin(end) ? (kin(at - 1) ? before : after)
      : lengths[at - 1]! >= lengths[end]! ? before : after;
    name.fill(to, at, end);
  }

  // The smaller line, one answer for as long as a name is up, or for as
  // long as the balloon is over one feature of a country.
  const detail = new Array<string | null>(n).fill(null);
  for (let a = 0; a < n;) {
    let b = a;
    while (b < n && name[b] === name[a]) b++;
    if (countries.slice(a, b).some((c) => c === name[a])) {
      // Under a country, what part of it.
      for (let f = a; f < b;) {
        let g = f;
        while (g < b && features[g] === features[f]) g++;
        if (features[f] && countries[f] === name[a] && g - f >= min) detail.fill(features[f]!, f, g);
        f = g;
      }
    } else if (named.slice(a, b).some((p) => p.country != null && p.feature === name[a])) {
      // Under a feature of the land, what it is in.
      detail.fill(mostly(countries.slice(a, b), 0.85) ?? mostly(wides.slice(a, b), 0.85), a, b);
    }
    a = b;
  }

  const out: (OverLine | null)[] = [];
  let since = 0;
  for (let f = 0; f < n; f++) {
    // The first name was there before the film began: it does not arrive.
    since = f === 0 ? 1e6 : name[f] === name[f - 1] ? since + 1 : 0;
    out.push(name[f] == null ? null : { name: name[f]!, detail: detail[f]!, since });
  }
  return out;
}
