// Write src/data/places.json: the names of what a balloon can be over,
// for the reel's "over" line (src/lib/reel/places.ts). Countries, seas and
// oceans, and the big features of the land (deserts, ranges, plateaus,
// plains), each as a name and its outline.
//
// The source is Natural Earth (naturalearthdata.com), which is in the
// public domain, at a pinned release so the file is reproducible. It is
// cut down hard on the way in: outer rings only, thinned to a tenth of a
// degree or so, small fry dropped. At the speed a reel plays, a coastline
// good to ten kilometres is better than it needs, and where a desert or a
// mountain range stops was never that exact.
//
// The output is committed, like the channel table: the reel reads it with
// no network. Run this only to change what is in it:  npm run gen:places
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/";
const STEP = 20; // stored units per degree
/** Features of the land worth naming, down to this rank (0 the largest). */
const LAND_KINDS = new Set(["Desert", "Range/mtn", "Plateau", "Plain", "Basin", "Geoarea",
  "Pen/cape", "Tundra", "Lowland"]);
const LAND_RANK = 3;
const SEA_RANK = 3;

const load = async (name) => {
  const res = await fetch(`${SOURCE}${name}.geojson`);
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return (await res.json()).features;
};

const SMALL = new Set(["of", "the", "and", "al"]);
const SHORT = { "MTS.": "Mountains", "RA.": "Range", "PEN.": "Peninsula", "PLAT.": "Plateau" };
/** A name as the source labels a feature (SAHARA, CAUCASUS MTS., Black
 * Sea), as a name: abbreviations written out, capitals only where they
 * belong. */
const titled = (s) => s.replace(/\S+/g, (w) => SHORT[w.toUpperCase()] ?? w)
  .toLowerCase()
  .replace(/[^\s-]+/g, (w, i) => (i > 0 && SMALL.has(w) ? w : w[0].toUpperCase() + w.slice(1)));
/** A land feature's name. The source's own label, unless that is in the
 * local language (PENÍNSULA IBÉRICA, DESIERTO DE ATACAMA), when its
 * English name is used. */
const landName = (p) => (/[^\x00-\x7f]|\b(DE|DU|DO|DES|DEL)\b/i.test(p.NAME) && p.NAME_EN
  ? titled(p.NAME_EN) : titled(p.NAME));

/** Douglas-Peucker: drop the points of a ring that stray less than `tol`
 * stored units from the line through their neighbours. */
function thin(flat, tol) {
  const n = flat.length / 2;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = flat[2 * a], ay = flat[2 * a + 1];
    const dx = flat[2 * b] - ax, dy = flat[2 * b + 1] - ay;
    const span = Math.hypot(dx, dy) || 1;
    let worst = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = flat[2 * i] - ax, py = flat[2 * i + 1] - ay;
      const d = dx || dy ? Math.abs(px * dy - py * dx) / span : Math.hypot(px, py);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(flat[2 * i], flat[2 * i + 1]);
  return out;
}

/** A feature's outer rings as flat integer arrays, with those too small to
 * matter (under `minDeg2` square degrees) left out. */
function rings(geometry, minDeg2, tolDeg = 0) {
  const polys = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  const out = [];
  for (const poly of polys) {
    const flat = [];
    for (const [lon, lat] of poly[0]) {
      const x = Math.round(lon * STEP);
      const y = Math.round(lat * STEP);
      if (flat.length && flat.at(-2) === x && flat.at(-1) === y) continue;
      flat.push(x, y);
    }
    if (flat.length < 8) continue;
    let area = 0;
    for (let i = 0; i + 3 < flat.length; i += 2) area += flat[i] * flat[i + 3] - flat[i + 2] * flat[i + 1];
    if (Math.abs(area) / 2 / (STEP * STEP) < minDeg2) continue;
    const ring = tolDeg ? thin(flat, tolDeg * STEP) : flat;
    if (ring.length >= 8) out.push(ring);
  }
  return out;
}

const [countries, seas, land] = await Promise.all([
  load("ne_110m_admin_0_countries"), load("ne_50m_geography_marine_polys"),
  load("ne_50m_geography_regions_polys"),
]);

const places = {
  // [name, continent, rings]
  countries: countries.map(({ properties: p, geometry }) => {
    const name = p.NAME === "United States of America" ? "United States"
      : p.NAME.includes(".") ? p.NAME_LONG : p.NAME;
    return [name, p.CONTINENT, rings(geometry, 0.02)];
  }).filter((c) => c[2].length),
  // [name, 1 for an ocean, rings]
  seas: seas.filter(({ properties: p }) => p.scalerank <= SEA_RANK
    && ["ocean", "sea", "gulf", "bay"].includes(p.featurecla))
    .map(({ properties: p, geometry }) => [
      titled(p.name), p.featurecla === "ocean" ? 1 : 0, rings(geometry, 1, 0.1)])
    .filter((c) => c[2].length),
  // [name, rings]
  land: land.filter(({ properties: p }) => p.SCALERANK <= LAND_RANK && LAND_KINDS.has(p.FEATURECLA)
    && p.REGION !== "Antarctica" && p.NAME !== "INDIA")
    .map(({ properties: p, geometry }) => [landName(p), rings(geometry, 1, 0.15)])
    // Not the ones that say nothing without a map around them to say
    // whose coastal plain or central highlands they are.
    .filter((c) => c[1].length && !/^(Coastal|Central|Western|Cord\.)\s/.test(c[0])),
};

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../src/data/places.json");
const text = JSON.stringify(places);
writeFileSync(out, text + "\n");
console.log(`wrote ${out}: ${places.countries.length} countries, ${places.seas.length} seas, `
  + `${places.land.length} land features, ${Math.round(text.length / 1024)} kB`);
