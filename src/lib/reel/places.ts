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
 * settled over the whole film before any of it is shown (`settle`): at
 * each instant it takes the most particular name that stays true long
 * enough to read, falling back from a mountain range to its country to
 * the continent.
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
  name: string;
  /** The country or continent a land feature is in, when that too holds
   * still long enough. */
  within: string | null;
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

/** One name for each frame out of several lists of them, the most
 * particular list first, such that no name is on screen for less than
 * `min` frames.
 *
 * Each frame first takes the most particular name that holds for `min`
 * frames unbroken, and failing any, the broadest there is. What is then
 * still too brief is a strip of something else across the path: the
 * Adriatic between Italy and the Balkans, a corner of a neighbouring
 * country. It joins a neighbour: one that is itself too brief, if there
 * is one, so that a run of scraps (a coast, a strait, an island, a sea)
 * adds up to a name that can be read, the largest scrap's; otherwise the
 * neighbour that is its own broader name (sea between two stretches of
 * "Europe" is, at that grain, Europe), or the longer one. That is the one
 * place a name stands over ground it is not strictly the name of, for
 * less than `min` frames at a time.
 *
 * The first name and the last are left as they are however brief: where
 * the flight began and where it is now are the two places that matter
 * most, and the first is the frame a film is judged by. */
function settle(levels: (string | null)[][], min: number): (string | null)[] {
  const n = levels[0]?.length ?? 0;
  const runs = levels.map(runLengths);
  const out: (string | null)[] = [];
  for (let f = 0; f < n; f++) {
    let pick: string | null = null;
    for (let k = 0; k < levels.length && pick == null; k++) {
      if (levels[k]![f] != null && runs[k]![f]! >= min) pick = levels[k]![f]!;
    }
    for (let k = levels.length - 1; k >= 0 && pick == null; k--) pick = levels[k]![f] ?? null;
    out.push(pick);
  }
  for (;;) {
    const lengths = runLengths(out);
    // The briefest run between two others.
    let at = -1;
    let least = min;
    for (let a = 0; a < n; a += lengths[a]!) {
      if (lengths[a]! < least && a > 0 && a + lengths[a]! < n) { least = lengths[a]!; at = a; }
    }
    if (at < 0) break;
    const end = at + least;
    const before = { name: out[at - 1]!, length: lengths[at - 1]!, edge: at - lengths[at - 1]! === 0 };
    const after = { name: out[end]!, length: lengths[end]!, edge: end + lengths[end]! === n };
    const brief = (r: typeof before) => r.length < min && !r.edge;
    const broader = (r: typeof before) => r.name != null
      && levels.some((l) => l.slice(at, end).some((v) => v === r.name));
    const to = brief(before) !== brief(after) ? (brief(before) ? before : after)
      : broader(before) !== broader(after) ? (broader(before) ? before : after)
      : before.length >= after.length ? before : after;
    out.fill(to.name, at, end);
  }
  return out;
}

/** The "over" line for every frame of a film, from the names at each. */
export function overLine(found: Named[], minFrames: number): (OverLine | null)[] {
  // The outlines are coarse, and a fjord coast can fall between the land
  // and the sea with no name at all: such a frame takes its neighbour's.
  const blank = (p: Named) => !p.feature && !p.country && !p.wide;
  const named = found.map((p, f) => {
    if (!blank(p)) return p;
    for (let d = 1; d < found.length; d++) {
      const near = [found[f - d], found[f + d]].find((q) => q && !blank(q));
      if (near) return near;
    }
    return p;
  });
  const name = settle([
    named.map((p) => p.feature),
    named.map((p) => p.country),
    named.map((p) => p.wide),
  ], minFrames);
  // At the two ends, where a brief name is let stand, the country says
  // more than the continent it fell back to.
  for (const [from, step] of [[0, 1], [named.length - 1, -1]] as const) {
    const first = name[from];
    for (let f = from; f >= 0 && f < named.length && name[f] === first; f += step) {
      if (named[f]!.wide === first && named[f]!.country) name[f] = named[f]!.country;
    }
  }
  // What a land feature is in: its country, or its continent when it
  // spans several, one answer for as long as the name is up.
  const within = new Array<string | null>(named.length).fill(null);
  for (let a = 0; a < named.length;) {
    let b = a;
    while (b < named.length && name[b] === name[a]) b++;
    if (named.slice(a, b).some((p) => p.country != null && p.feature === name[a])) {
      for (const pick of [(p: Named) => p.country, (p: Named) => p.wide]) {
        const counts = new Map<string, number>();
        for (let f = a; f < b; f++) {
          const v = pick(named[f]!);
          if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        const [top, count] = [...counts].sort((x, y) => y[1] - x[1])[0] ?? [null, 0];
        if (top && count >= 0.85 * (b - a)) { within.fill(top, a, b); break; }
      }
    }
    a = b;
  }
  const out: (OverLine | null)[] = [];
  let since = 0;
  for (let f = 0; f < named.length; f++) {
    // The first name was there before the film began: it does not arrive.
    since = f === 0 ? 1e6 : name[f] === name[f - 1] ? since + 1 : 0;
    out.push(name[f] == null ? null : {
      name: name[f]!,
      within: within[f] !== name[f] ? within[f]! : null,
      since,
    });
  }
  return out;
}
