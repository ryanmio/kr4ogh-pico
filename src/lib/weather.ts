/** Weather under the track: rain radar, or infrared cloud tops.
 *
 * Two layers, because neither one alone covers a pico flight. Radar is a
 * mosaic of national radar networks, so it stops a couple of hundred km off
 * any coast and is blank for most of an ocean crossing. Geostationary
 * infrared covers the ocean but shows cloud tops, not rain: a towering cold
 * top is a storm, a warm featureless sheet is not. Over land, near a coast,
 * radar answers "is it raining under the balloon"; out at sea, infrared is
 * the only thing that answers anything.
 *
 * Both sources are keyless and send `access-control-allow-origin: *`, so
 * this holds to the same rule as the telemetry: no proxy, no credentials in
 * the build, nothing of ours awake. If either source is down the layer
 * simply does not appear and the map is what it always was.
 *
 * Offered on every flight, live or closed. The layers are always today's
 * weather, and the track under them is always older than that: a live
 * flight's tail is two weeks of history too. The reader knows what they are
 * looking at, and the switch defaults to off.
 */

import L from "leaflet";

export type WeatherLayer = "off" | "rain" | "clouds";

const STORAGE_KEY = "pico-weather";

export function isWeatherLayer(v: unknown): v is WeatherLayer {
  return v === "off" || v === "rain" || v === "clouds";
}

/** The query parameter that pins the layer for one link: `?w=c` for clouds,
 * `?w=r` for rain, `?w=n` for none. The long forms are accepted too, so a
 * hand-typed `?w=clouds` works. */
export const URL_PARAM = "w";

const FROM_URL: Record<string, WeatherLayer> = {
  c: "clouds", clouds: "clouds",
  r: "rain", rain: "rain", radar: "rain",
  n: "off", none: "off", off: "off",
};

const TO_URL: Record<WeatherLayer, string> = {
  clouds: "c", rain: "r", off: "n",
};

/** Read the layer out of a query string, or null when it does not ask for
 * one.
 *
 * Takes the search string rather than reading `location` so it stays pure
 * and testable, and so a caller can parse a link it has not navigated to.
 * An unrecognised value is null, not an error: a share link with a typo in
 * it should still show the flight.
 */
export function weatherFromSearch(search: string): WeatherLayer | null {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get(URL_PARAM);
  } catch {
    return null;
  }
  if (raw === null) return null;
  return FROM_URL[raw.trim().toLowerCase()] ?? null;
}

/** The layer for a page load: the link wins, then the browser's memory, then
 * nothing.
 *
 * Same rule as the units, and for the same reason. Someone sending a link
 * with the storm on it means the recipient to see the storm, and a stored
 * preference of their own must not silently override it. It does not write
 * through to storage either: following someone else's link is not the reader
 * choosing a default, and must not quietly rewrite one they already set.
 */
export function resolveWeather(
  search: string, fallback: WeatherLayer = "off",
): WeatherLayer {
  return weatherFromSearch(search) ?? loadWeather(fallback);
}

/** The same page with the layer pinned, for the address bar. Preserves every
 * other parameter and the hash, so it composes with `?u=` and survives a
 * deep link. */
export function urlWithWeather(href: string, layer: WeatherLayer): string {
  const url = new URL(href);
  url.searchParams.set(URL_PARAM, TO_URL[layer]);
  return url.toString();
}

/** The reader's choice, remembered per browser. Storage can throw (private
 * windows, blocked site data), so it is guarded exactly like the units. */
export function loadWeather(fallback: WeatherLayer = "off"): WeatherLayer {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isWeatherLayer(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function saveWeather(layer: WeatherLayer): void {
  try {
    localStorage.setItem(STORAGE_KEY, layer);
  } catch {
    /* the layer still switches; the choice just is not remembered */
  }
}

// ---------- rain radar ----------

const RAINVIEWER_INDEX = "https://api.rainviewer.com/public/weather-maps.json";

/** Colour scheme 4 (greens through reds), smoothed, with snow shown
 * separately. The scheme matters on a dark basemap: the blue-only schemes
 * disappear into the ocean fill. */
const RADAR_STYLE = "4/1_1";

interface RadarFrame {
  /** Tile URL prefix for the frame, minus the `/{z}/{x}/{y}` tail. */
  base: string;
  /** Frame time, unix seconds. */
  time: number;
}

let radarFramePromise: Promise<RadarFrame | null> | null = null;

/** The newest radar frame, fetched at most once every few minutes.
 *
 * RainViewer publishes a rolling index of frames and the tile path for each
 * one changes every ten minutes, so the URL cannot be hardcoded. The map is
 * torn down and rebuilt on every telemetry refresh, which is every two
 * minutes, and refetching the index that often would be pure waste — hence
 * the cached promise. Failure caches too, as null, so a dead source is not
 * retried on a loop; the timer clears it either way.
 */
function latestRadarFrame(): Promise<RadarFrame | null> {
  if (!radarFramePromise) {
    radarFramePromise = fetch(RAINVIEWER_INDEX)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d): RadarFrame | null => {
        const past = d?.radar?.past;
        const frame = Array.isArray(past) ? past[past.length - 1] : null;
        if (!frame?.path || typeof d.host !== "string") return null;
        return { base: `${d.host}${frame.path}/256`, time: Number(frame.time) };
      })
      .catch(() => null);
    setTimeout(() => { radarFramePromise = null; }, 5 * 60 * 1000);
  }
  return radarFramePromise;
}

/** A weather product as bare tiles, for whichever renderer is asking. The
 * flat map wraps these in a Leaflet layer below; the globe hangs the same
 * URLs on its sphere. */
export interface WeatherTiles {
  /** URL template with {z}, {x} and {y} placeholders. */
  url: string;
  attribution: string;
  /** The product stops here; past it the renderer upscales the tile it
   * already has rather than asking for one that does not exist. */
  maxNativeZoom: number;
  opacity: number;
}

export async function rainTiles(): Promise<WeatherTiles | null> {
  const frame = await latestRadarFrame();
  if (!frame) return null;
  return {
    url: `${frame.base}/{z}/{x}/{y}/${RADAR_STYLE}.png`,
    opacity: 0.85,
    // The mosaic is built to zoom 10.
    maxNativeZoom: 10,
    attribution:
      `Radar ${hhmmUtc(frame.time)} UTC &copy; ` +
      '<a href="https://www.rainviewer.com/">RainViewer</a>',
  };
}

async function rainLayer(): Promise<L.TileLayer | null> {
  const t = await rainTiles();
  if (!t) return null;
  return L.tileLayer(t.url, {
    className: "weather-tiles weather-rain",
    opacity: t.opacity,
    maxNativeZoom: t.maxNativeZoom,
    maxZoom: 16,
    attribution: t.attribution,
  });
}

function hhmmUtc(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(11, 16);
}

// ---------- infrared cloud tops ----------

/** Longwave infrared (about 10.4 µm: cloud-top brightness temperature) from
 * five geostationary satellites, all drawn at once, each over the slice of
 * longitude it is nearest to. Between them they ring the planet, so the
 * layer is there wherever the balloon is, and a balloon near a boundary
 * sees the weather on both sides of it.
 *
 * Two servers, because neither has all five. NASA GIBS has the American
 * and Japanese satellites as ready-cut epsg3857 tiles, and nothing from
 * Meteosat. EUMETSAT's own WMS has the two Meteosats, rendered for any box
 * it is asked for. Both are keyless and send `access-control-allow-origin:
 * *`, so the pixels can be read back and reworked. */
interface GeoSat {
  name: string;
  /** Sub-satellite longitude. */
  lon: number;
  /** How far behind real time to ask for its frame; see GIBS_LAG_MIN. */
  lagMin: number;
  source:
    | { kind: "gibs"; layer: string }
    | { kind: "eumetsat"; layer: string; toC(grey: number): number };
}

/** How far back to ask for, and the product's cadence.
 *
 * TIME=default is the obvious choice and the wrong one. It resolves to
 * whatever the node serving the request has finished ingesting, which is not
 * the same answer twice in a row -- two probes seconds apart came back 12:30
 * and 12:50 -- so a single map ends up drawn from several different times,
 * with a tile-shaped hole wherever one of them is not ready yet.
 *
 * So take the newest slot comfortably older than the source's lag and ask
 * for it by name. One frame, one moment, no holes, at the cost of most of
 * an hour of freshness -- which for cloud tops over an ocean is nothing,
 * and a good trade for a picture that is all there.
 *
 * GIBS' lag differs by satellite and by the day. Sampling nine GOES-East
 * tiles once had everything 30 minutes or older complete; another evening
 * its newest frame was 42 minutes old and GOES-West's and Himawari's 52.
 * Asking any of them for less than an hour back meant a 404 and a retry on
 * every tile much of the time. EUMETSAT ran 10 to 25 minutes behind when
 * probed. MTG has the same ten-minute cadence; Meteosat-9 scans every
 * fifteen and the server answers with its nearest. The seam between a GIBS
 * and a EUMETSAT slice therefore joins frames 20 minutes apart, which the
 * blend across it hides.
 *
 * Even an old slot is sometimes simply not there: GIBS' Himawari skips
 * 02:40 and 14:40 every day and the GOES records have gaps. A GIBS tile
 * that fails steps back a slot at a time, up to IR_FALLBACK_SLOTS, rather
 * than leave a hole. EUMETSAT never needs to: it answers any time with its
 * nearest frame, so a failure there is the server struggling, and asking
 * it again for an older frame only lengthens its queue. */
const GIBS_LAG_MIN = 60;
const EUMETSAT_LAG_MIN = 40;
const IR_STEP_MIN = 10;
const IR_FALLBACK_SLOTS = 2;

/** EUMETSAT renders every tile on request, one at a time as far as a
 * client can tell, and only over HTTP/1.1, so the browser holds six
 * requests open to it and queues the rest. In the evening a tile took under
 * a second; under load the eighth tile of one map took 18 seconds. A
 * request still hanging after this long is dropped, freeing its connection,
 * and the tile is asked for again by the next map that wants it. */
const IR_TIMEOUT_MS = 30_000;

/** The newest slot at least `lagMin` before `now`, as an ISO timestamp. */
function irFrameTime(now: number, lagMin: number): string {
  const step = IR_STEP_MIN * 60_000;
  const slot = Math.floor((now - lagMin * 60_000) / step) * step;
  return `${new Date(slot).toISOString().slice(0, 19)}Z`;
}

/** Meteosat-9's grey ramp is not linear in temperature -- it is a stretch
 * of radiance, which flattens out at the cold end -- and the server
 * publishes no legend for it. So it is carried across from MTG's, below, by
 * percentile matching over the 0-45 E overlap at three times of day: the
 * nth-percentile grey of one paired with the nth-percentile temperature of
 * the other. Percentiles rather than pixel pairs, because the two see each
 * cloud from 45 degrees apart and minutes apart, and paired pixels then
 * regress toward the mean. Past -63 C the sample is too thin and the last
 * point is extrapolated. */
const IODC_GREY_C: [number, number][] = [
  [0, 26], [11, 22.7], [27, 18.4], [36, 14.9], [57, 8.0], [79, 2.0],
  [93, -2.4], [116, -11.8], [130, -17.0], [150, -23.9], [164, -28.7],
  [176, -33.0], [193, -39.0], [201, -42.5], [214, -47.6], [225, -52.0],
  [245, -63.2], [255, -69],
];

const GEO_SATS: GeoSat[] = [
  {
    name: "GOES-West", lon: -137.0, lagMin: GIBS_LAG_MIN,
    source: { kind: "gibs", layer: "GOES-West_ABI_Band13_Clean_Infrared" },
  },
  {
    name: "GOES-East", lon: -75.2, lagMin: GIBS_LAG_MIN,
    source: { kind: "gibs", layer: "GOES-East_ABI_Band13_Clean_Infrared" },
  },
  {
    // MTG's published legend: white at -80 C to black at +30 C, linear.
    // Checked against GOES-East over the mid-Atlantic, it agrees to within
    // about 3 C from +16 C down to -64 C.
    name: "Meteosat (MTG)", lon: 0, lagMin: EUMETSAT_LAG_MIN,
    source: {
      kind: "eumetsat", layer: "mtg_fd:ir105_hrfi",
      toC: (grey) => 30 - (grey * 110) / 255,
    },
  },
  {
    name: "Meteosat-9", lon: 45.5, lagMin: EUMETSAT_LAG_MIN,
    source: {
      kind: "eumetsat", layer: "msg_iodc:ir108",
      toC: (grey) => interpolate(IODC_GREY_C, grey)[0]!,
    },
  },
  {
    name: "Himawari", lon: 140.7, lagMin: GIBS_LAG_MIN,
    source: { kind: "gibs", layer: "Himawari_AHI_Band13_Clean_Infrared" },
  },
];

/** Half-width of the blend at each seam, in degrees of longitude. Two
 * satellites see a cloud from different angles and minutes apart, so it
 * sits a little differently in each, and a hard cut would show as a line.
 * The seams fall halfway between neighbours, so no slice reaches further
 * than about 48 degrees from its own satellite. */
const SEAM_FEATHER_DEG = 4;

const TILE = 256;

/** Where the drawn disc starts fading and where it ends.
 *
 * The published tiles do not stop at the useful part of the disc: they run
 * to its geometric edge, where the camera sees the atmosphere edge-on and
 * everything smears cold, and past it, where resampling leaves cold-looking
 * junk. Unmasked, that paints a white ring around the whole disc and a
 * solid blob over the Arctic — on a zoomed-out map the ring and the blob
 * were the only "clouds" visible, because genuine scattered cloud averages
 * away into warm grey when downsampled while the edge stays uniformly cold.
 * So the layer is cut by geometry, not temperature: full strength to 60°
 * from the sub-point, gone by 70°. Cold polar surfaces (Greenland, sea ice)
 * sit past 70° from every sub-point and are cut by the same knife. The
 * slices keep each satellite well inside its disc east to west; this is
 * what still bites toward the poles. */
const DISC_FULL_COS = Math.cos((60 * Math.PI) / 180);
const DISC_EDGE_COS = Math.cos((70 * Math.PI) / 180);

/** Linear interpolation in a table sorted by its first column, clamped at
 * both ends; returns the remaining columns. */
function interpolate(table: number[][], x: number): number[] {
  const first = table[0]!;
  const last = table[table.length - 1]!;
  if (x <= first[0]!) return first.slice(1);
  if (x >= last[0]!) return last.slice(1);
  let k = 1;
  while (table[k]![0]! < x) k++;
  const a = table[k - 1]!;
  const b = table[k]!;
  const t = (x - a[0]!) / (b[0]! - a[0]!);
  return a.slice(1).map((v, j) => v + (b[j + 1]! - v) * t);
}

/** The slices: for each tile column, how much each satellite contributes.
 * The nearest satellite in longitude has it outright, except within
 * SEAM_FEATHER_DEG of a seam, where it shares with the one across. Only
 * satellites with a share somewhere in the tile are returned, so most
 * tiles fetch one source and only those on a seam fetch two. Column
 * longitude is linear in tile x, and the distance is taken round the
 * circle, so the antimeridian needs no special case. */
function columnWeights(
  coords: { x: number; z: number }, width: number,
): { sat: GeoSat; w: Float32Array }[] {
  const n = 2 ** coords.z;
  const ws = GEO_SATS.map(() => new Float32Array(width));
  for (let c = 0; c < width; c++) {
    const lon = ((coords.x + (c + 0.5) / width) / n) * 360 - 180;
    let k1 = 0, k2 = 0, d1 = Infinity, d2 = Infinity;
    GEO_SATS.forEach((sat, k) => {
      const d = Math.abs(((lon - sat.lon + 540) % 360) - 180);
      if (d < d1) { k2 = k1; d2 = d1; k1 = k; d1 = d; }
      else if (d < d2) { k2 = k; d2 = d; }
    });
    const w1 = Math.min(1, 0.5 + (d2 - d1) / (4 * SEAM_FEATHER_DEG));
    ws[k1]![c] = w1;
    ws[k2]![c] = 1 - w1;
  }
  return GEO_SATS.map((sat, k) => ({ sat, w: ws[k]! }))
    .filter((s) => s.w.some((v) => v > 0));
}

/** Half the width of the epsg3857 world, in metres. */
const MERCATOR_HALF = 20037508.342789244;

function tileUrl(
  sat: GeoSat, coords: { x: number; y: number; z: number }, time: string,
): string {
  const { x, y, z } = coords;
  if (sat.source.kind === "gibs") {
    return "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" +
      `${sat.source.layer}/default/${time}/GoogleMapsCompatible_Level6/${z}/${y}/${x}.png`;
  }
  const span = (2 * MERCATOR_HALF) / 2 ** z;
  const west = -MERCATOR_HALF + x * span;
  const north = MERCATOR_HALF - y * span;
  const bbox = [west, north - span, west + span, north].join(",");
  return "https://view.eumetsat.int/geoserver/wms?service=WMS&version=1.3.0" +
    `&request=GetMap&layers=${sat.source.layer}&styles=&crs=EPSG:3857` +
    `&bbox=${bbox}&width=${TILE}&height=${TILE}&format=image/png` +
    `&transparent=true&time=${time}`;
}

/** One source tile as raw pixels, or null when it could not be had: GIBS
 * has no such frame (a 404), either server had a bad moment, or it took
 * longer than IR_TIMEOUT_MS. */
async function fetchPixels(url: string): Promise<Uint8ClampedArray | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(IR_TIMEOUT_MS) });
    if (!resp.ok) return null;
    const bmp = await createImageBitmap(await resp.blob());
    const canvas = new OffscreenCanvas(TILE, TILE);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, TILE, TILE);
    bmp.close();
    return ctx.getImageData(0, 0, TILE, TILE).data;
  } catch {
    return null;
  }
}

/** One satellite's tile for this map, a GIBS one stepping back a slot at a
 * time when its frame is missing. Null when it could not be had: that slice
 * is then absent from this one tile, and the rest of the tile still draws. */
async function fetchSlice(
  sat: GeoSat, coords: { x: number; y: number; z: number }, now: number,
): Promise<Uint8ClampedArray | null> {
  const slots = sat.source.kind === "gibs" ? IR_FALLBACK_SLOTS : 0;
  for (let back = 0; back <= slots; back++) {
    const time = irFrameTime(now, sat.lagMin + back * IR_STEP_MIN);
    const px = await fetchPixels(tileUrl(sat, coords, time));
    if (px) return px;
  }
  return null;
}

/** False when the disc mask would clear the satellite's whole share of the
 * tile, which then need not be fetched at all. Polar tiles are the common
 * case; GIBS has no tile there anyway, and asking would only collect 404s
 * and fall back through earlier slots that do not have one either. */
function reachesDisc(
  coords: { x: number; y: number; z: number }, satLon: number, w: Float32Array,
): boolean {
  const n = 2 ** coords.z;
  const latAt = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const north = latAt(coords.y);
  const south = latAt(coords.y + 1);
  const maxRowCos = north > 0 && south < 0
    ? 1 : Math.max(Math.cos(north), Math.cos(south));
  let maxColCos = -1;
  for (let c = 0; c < w.length; c++) {
    if (w[c] === 0) continue;
    const lon = ((coords.x + (c + 0.5) / w.length) / n) * 360 - 180;
    maxColCos = Math.max(maxColCos, Math.cos(((lon - satLon) * Math.PI) / 180));
  }
  return maxRowCos * maxColCos > DISC_EDGE_COS;
}

/** Warmest cloud that gets drawn at all, and the coldest grey the GIBS
 * colour map uses before it starts colouring. Between the two the layer
 * fades in as cloud; below it the storm colours take over. */
const GREY_CLEAR_C = 5;
const GREY_COLD_C = -18.4;

/** GIBS grey level to brightness temperature, from the published colour
 * map: it is linear over the grey range, 196 at -18.4 C down to 9 at
 * +53.6 C. */
const GREY_AT_COLD = 196;
const C_PER_GREY = (53.6 - GREY_COLD_C) / (GREY_AT_COLD - 9);

function greyToC(grey: number): number {
  return GREY_COLD_C + (GREY_AT_COLD - grey) * C_PER_GREY;
}

/** Peak opacity of the white cloud field. The colours are drawn harder than
 * this: cloud is context, a storm is the message. */
const CLOUD_ALPHA = 0.62;
const STORM_ALPHA = 0.92;

/** Opacity of the cloud field at a temperature: clear at GREY_CLEAR_C,
 * full cloud by GREY_COLD_C. */
function cloudAlpha(c: number): number {
  const t = (GREY_CLEAR_C - c) / (GREY_CLEAR_C - GREY_COLD_C);
  return t <= 0 ? 0 : Math.round(255 * CLOUD_ALPHA * Math.min(t, 1));
}

/** The GIBS colour map (Clean_Longwave_Infrared_Window_Band) from where
 * this layer starts colouring, -32 C, down: green, yellow, red, a grey
 * band, pink to magenta, white past -91 C. It is linear between these
 * points, taken at the centre of each published one-degree step. GIBS tiles
 * arrive already painted in it; EUMETSAT's are grey, and are painted in it
 * here so a storm looks the same on either side of a seam. */
const STORM_FROM_C = -32.1;
const STORM_COLOURS: [number, number, number, number][] = [
  [-91.6, 255, 255, 255],
  [-90.6, 127, 0, 127],
  [-80.6, 255, 127, 203],
  [-79.6, 230, 230, 230],
  [-70.6, 5, 5, 5],
  [-69.6, 26, 0, 0],
  [-60.6, 255, 0, 0],
  [-50.6, 255, 255, 0],
  [-40.6, 0, 255, 0],
  [-32.6, 0, 85, 77],
];

/** True for the colour map's first band, cyan through blue to teal, which
 * runs -19.4 C to -32 C.
 *
 * That band has to go. GIBS starts colouring at -19 C, which is colder than
 * most cloud but nowhere near a storm, so the band ends up tracing a bright
 * cyan outline around every cloud edge on the map and burying the colours
 * that mean something. Dropping it starts the colour at green, about -33 C,
 * which is roughly where deep convection starts and what an enhanced
 * infrared chart on television is showing.
 *
 * The test is exact on the published palette -- through the blue band blue
 * is at least green, and from green on down green is strictly greater -- and
 * degrades the right way on the blended colours that resampled tiles are
 * full of. `r <= g` spares the two magentas at the far cold end, below -84 C,
 * which are blue-heavy but are the most extreme tops there are. */
function isBlueBand(r: number, g: number, b: number): boolean {
  return b >= g && r <= g;
}

/** Turn a GIBS tile into something that can be laid over a map without
 * burying it.
 *
 * The GIBS layer is already an enhanced infrared product, not a plain grey
 * picture: grey from about +57 C down to -19 C, and colour below that --
 * cyan, blue, green, yellow, orange, red, magenta, on down past -90 C.
 * Those colours are the storms, and they are the whole point of the layer.
 *
 * The tile arrives fully opaque — sea, land and sky all painted some shade
 * of grey — so laid on flat it hides the coastlines the map exists to show.
 * The obvious fix, a CSS filter, is worse than useless here: `grayscale()`
 * turns a red -62 C storm top into luminance 43, which any contrast curve
 * steep enough to clear the warm background then erases completely. It
 * deletes precisely the pixels worth keeping and keeps the harmless ones.
 *
 * So the alpha is computed from the data instead. Grey means warmer than
 * -19 C: convert it back to a temperature and fade in from clear sky to
 * cloud. Colour means colder, and is kept exactly as published, near-opaque
 * — those are the cold tops, the thing a balloon cares about — except for
 * the warmest colour band, which is cloud wearing a storm's clothes; see
 * isBlueBand.
 *
 * One honest limitation: over ice, or a polar winter, the surface itself is
 * colder than the fade-in threshold and reads as cloud. Between the tropics
 * and about 60 degrees, where these balloons fly, it does not come up.
 */
function enhance(px: Uint8ClampedArray): void {
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i]!;
    const g = px[i + 1]!;
    const b = px[i + 2]!;
    if (r !== g || g !== b) {
      if (isBlueBand(r, g, b)) {
        // Cold, but only cloud: white, at the top of the cloud fade.
        px[i] = px[i + 1] = px[i + 2] = 255;
        px[i + 3] = Math.round(255 * CLOUD_ALPHA);
      } else {
        px[i + 3] = Math.round(255 * STORM_ALPHA);
      }
      continue;
    }
    // Grey 255 is the single entry below -91 C, colder than the colours
    // and far colder than anything the ramp below covers. (Grey 0, the
    // off-disc fill, lands below the ramp's threshold and goes clear.)
    if (r > GREY_AT_COLD) {
      px[i + 3] = Math.round(255 * STORM_ALPHA);
      continue;
    }
    px[i + 3] = cloudAlpha(greyToC(r));
  }
}

/** What enhance would have made of a temperature, had GIBS painted it:
 * GIBS' grey and the cloud fade above -18 C, white cloud through the
 * dropped blue band, the storm colours below. Built once per EUMETSAT
 * source as a 256-entry lookup on its grey level, since that is all a
 * pixel's colour depends on. */
const luts = new Map<GeoSat, Uint8ClampedArray>();
function eumetsatLut(sat: GeoSat, toC: (grey: number) => number): Uint8ClampedArray {
  let lut = luts.get(sat);
  if (lut) return lut;
  lut = new Uint8ClampedArray(256 * 4);
  for (let grey = 0; grey < 256; grey++) {
    const c = toC(grey);
    const i = grey * 4;
    if (c <= STORM_FROM_C) {
      lut.set(interpolate(STORM_COLOURS, c), i);
      lut[i + 3] = Math.round(255 * STORM_ALPHA);
    } else if (c <= GREY_COLD_C) {
      lut.set([255, 255, 255, Math.round(255 * CLOUD_ALPHA)], i);
    } else {
      const g = Math.round(GREY_AT_COLD - (c - GREY_COLD_C) / C_PER_GREY);
      lut.set([g, g, g, cloudAlpha(c)], i);
    }
  }
  luts.set(sat, lut);
  return lut;
}

/** The EUMETSAT counterpart of enhance. Off the disc the server answers
 * transparent, and that is kept. */
function paintEumetsat(px: Uint8ClampedArray, lut: Uint8ClampedArray): void {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]!;
    if (a === 0) continue;
    const j = px[i]! * 4;
    px[i] = lut[j]!;
    px[i + 1] = lut[j + 1]!;
    px[i + 2] = lut[j + 2]!;
    px[i + 3] = Math.round((lut[j + 3]! * a) / 255);
  }
}

/** Multiply per-pixel alpha by the disc mask for one tile.
 *
 * The angular distance from the sub-point factors: cos θ = cos φ · cos Δλ,
 * with φ per pixel row (inverse mercator) and Δλ per pixel column, so the
 * mask is two 256-entry tables and a multiply, not 65k trig calls. Column
 * longitude is linear in tile x, so wrapped world copies come out right
 * through the cosine's own periodicity. */
function maskDisc(
  px: Uint8ClampedArray, size: { x: number; y: number },
  coords: { x: number; y: number; z: number }, satLon: number,
): void {
  const n = 2 ** coords.z;
  const rowCos = new Float64Array(size.y);
  for (let r = 0; r < size.y; r++) {
    const yNorm = (coords.y + (r + 0.5) / size.y) / n;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * yNorm)));
    rowCos[r] = Math.cos(lat);
  }
  const colCos = new Float64Array(size.x);
  for (let c = 0; c < size.x; c++) {
    const lon = ((coords.x + (c + 0.5) / size.x) / n) * 360 - 180;
    colCos[c] = Math.cos(((lon - satLon) * Math.PI) / 180);
  }
  const spanCos = DISC_FULL_COS - DISC_EDGE_COS;
  for (let r = 0; r < size.y; r++) {
    for (let c = 0; c < size.x; c++) {
      const f = (rowCos[r]! * colCos[c]! - DISC_EDGE_COS) / spanCos;
      if (f >= 1) continue;
      const i = (r * size.x + c) * 4;
      px[i + 3] = f <= 0 ? 0 : Math.round(px[i + 3]! * f);
    }
  }
}

/** Finished tiles, newest use last, and tiles still being drawn.
 *
 * The map is torn down and rebuilt on every telemetry refresh, every two
 * minutes, and the cloud layer with it. Without this every rebuild drew
 * every tile again from scratch: GIBS sends `no-store`, so nothing came out
 * of the browser's cache, and a rebuild while EUMETSAT was still working
 * through the last map's queue put a second copy of every request behind
 * the first. On a slow afternoon Europe never finished before the next
 * rebuild threw it away. Keyed by the frame slot as well as the tile, so a
 * new frame is a new tile; a tile with a slice missing is not kept, so the
 * next map asks again rather than inheriting the hole. */
const tileCache = new Map<string, Promise<CloudTile>>();
/** About 32 MB of pixels at most: several screens' worth across zooms. */
const TILE_CACHE_SIZE = 128;

export interface CloudTile {
  /** The pixels, or null where no source had anything. */
  data: ImageData | null;
  /** False when a slice that should be there could not be had. */
  complete: boolean;
}

/** One finished infrared tile at epsg3857 tile coordinates. Shared by both
 * renderers: the flat map runs it in a Leaflet layer, the globe in a tile
 * protocol. */
export function renderCloudTile(
  coords: { x: number; y: number; z: number }, now: number,
): Promise<CloudTile> {
  const key = `${now}/${coords.z}/${coords.x}/${coords.y}`;
  let tile = tileCache.get(key);
  if (tile) {
    // Most recently used goes last; eviction takes from the front.
    tileCache.delete(key);
    tileCache.set(key, tile);
    return tile;
  }
  tile = drawCloudTile(coords, now).then((t) => {
    if (!t.complete) tileCache.delete(key);
    return t;
  });
  tileCache.set(key, tile);
  while (tileCache.size > TILE_CACHE_SIZE) {
    tileCache.delete(tileCache.keys().next().value!);
  }
  return tile;
}

/** Draw one tile. Each satellite whose slice touches it is fetched, given
 * the per-pixel treatment for its source and cut to its disc, and the
 * results are mixed by their column weights: a weighted average of colour
 * by opacity, so where the slices overlap at a seam one fades into the
 * other rather than stacking up twice as opaque. */
async function drawCloudTile(
  coords: { x: number; y: number; z: number }, now: number,
): Promise<CloudTile> {
  const slices = columnWeights(coords, TILE)
    .filter((s) => reachesDisc(coords, s.sat.lon, s.w));
  const tiles = await Promise.all(
    slices.map((s) => fetchSlice(s.sat, coords, now)));
  const complete = tiles.every((px) => px !== null);
  const acc = new Float32Array(TILE * TILE * 4);
  let any = false;
  slices.forEach(({ sat, w }, k) => {
    const px = tiles[k];
    if (!px) return;
    any = true;
    if (sat.source.kind === "gibs") enhance(px);
    else paintEumetsat(px, eumetsatLut(sat, sat.source.toC));
    maskDisc(px, { x: TILE, y: TILE }, coords, sat.lon);
    for (let r = 0; r < TILE; r++) {
      for (let c = 0; c < TILE; c++) {
        const i = (r * TILE + c) * 4;
        const a = (px[i + 3]! / 255) * w[c]!;
        if (a === 0) continue;
        acc[i] += px[i]! * a;
        acc[i + 1] += px[i + 1]! * a;
        acc[i + 2] += px[i + 2]! * a;
        acc[i + 3] += a;
      }
    }
  });
  if (!any) return { data: null, complete };
  const out = new ImageData(TILE, TILE);
  for (let i = 0; i < acc.length; i += 4) {
    const a = acc[i + 3]!;
    if (a === 0) continue;
    out.data[i] = acc[i]! / a;
    out.data[i + 1] = acc[i + 1]! / a;
    out.data[i + 2] = acc[i + 2]! / a;
    out.data[i + 3] = a * 255;
  }
  return { data: out, complete };
}

/** The infrared layer's settings for one map. The tiles themselves come
 * from renderCloudTile, asked with this `now`. */
export interface CloudTiles extends Omit<WeatherTiles, "url"> {
  /** The moment every frame time is reckoned back from. Fixed for the
   * life of the layer, so every tile of one source is the same frame, and
   * snapped to the frame cadence, so successive rebuilds of the map ask for
   * the same tiles and find them already drawn. */
  now: number;
}

export function cloudTiles(at: number = Date.now()): CloudTiles {
  const step = IR_STEP_MIN * 60_000;
  const now = Math.floor(at / step) * step;
  const hhmm = (lagMin: number) => irFrameTime(now, lagMin).slice(11, 16);
  return {
    now,
    opacity: 1,
    // The GIBS products stop at zoom 6, and EUMETSAT's are no sharper.
    maxNativeZoom: 6,
    attribution:
      `Infrared UTC: GOES, Himawari ${hhmm(GIBS_LAG_MIN)} via ` +
      '<a href="https://worldview.earthdata.nasa.gov/">NASA GIBS</a>; ' +
      `Meteosat ${hhmm(EUMETSAT_LAG_MIN)} ` +
      '&copy; <a href="https://view.eumetsat.int/">EUMETSAT</a>',
  };
}

/** A tile missing a slice tries again by itself, this often and this many
 * times, for as long as it is on the map. Otherwise a slice that EUMETSAT
 * failed under load stays a hole until new telemetry happens to rebuild the
 * map, which can be most of an hour. */
const TILE_RETRY_MS = 60_000;
const TILE_RETRIES = 3;

/** A Leaflet layer that draws each tile with renderCloudTile. A tile with
 * nothing to show is left blank rather than failed: a blank square is
 * better than an error, and better still than an opaque one. */
const CloudLayer = L.GridLayer.extend({
  createTile(this: L.GridLayer, coords: L.Coords, done: L.DoneCallback) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = TILE;
    const { now } = this.options as { now: number };
    const paint = (attempt: number): void => {
      renderCloudTile(coords, now).then(
        ({ data, complete }) => {
          if (data) canvas.getContext("2d")?.putImageData(data, 0, 0);
          if (attempt === 0) done(undefined, canvas);
          if (complete || attempt >= TILE_RETRIES) return;
          // Leaflet detaches a tile it no longer shows: panned away,
          // zoomed past, or the whole layer gone with a rebuild.
          setTimeout(() => { if (canvas.isConnected) paint(attempt + 1); },
            TILE_RETRY_MS);
        },
        (err: Error) => { if (attempt === 0) done(err, canvas); },
      );
    };
    paint(0);
    return canvas;
  },
}) as new (options: L.GridLayerOptions & { now: number }) => L.GridLayer;

function cloudLayer(t: CloudTiles): L.GridLayer {
  return new CloudLayer({
    className: "weather-tiles weather-clouds",
    now: t.now,
    maxNativeZoom: t.maxNativeZoom,
    maxZoom: 16,
    attribution: t.attribution,
  });
}

// ---------- the control ----------

export interface WeatherOpts {
  /** Where the switch sits; default top right. The phone layout puts it at
   * the bottom, where it does not stack halfway down a short map. */
  position?: L.ControlPosition;
  /** Render the switch into this element instead of a map corner. The
   * desktop live view lines it up in the top bar with the other controls. */
  into?: HTMLElement;
  /** Layer to start on, so a rebuilt map comes back the way it went away. */
  initial: WeatherLayer;
  /** Called on every change, for the caller to remember across rebuilds. */
  onChange(layer: WeatherLayer): void;
}

const BUTTONS: { id: WeatherLayer; label: string; title: string }[] = [
  { id: "off", label: "Off", title: "Just the map" },
  {
    id: "rain",
    label: "Rain",
    title:
      "Rain radar, about ten minutes old. Land and coastal waters only; out " +
      "at sea it has nothing to show and Clouds is the layer to use.",
  },
  {
    id: "clouds",
    label: "Clouds",
    title:
      "Infrared cloud tops, about an hour old. White is cloud; the " +
      "colours are tops colder than about -33 C, which is what a storm " +
      "looks like from above. Works over the ocean, where radar does not.",
  },
];

/** The three-way switch itself, plain DOM so both renderers can use it: the
 * flat map puts it in a Leaflet corner or the top strip, the globe in its
 * own corner. It owns its pressed state; applying the layers is the
 * caller's half. */
export function buildWeatherToggle(opts: {
  initial: WeatherLayer;
  onSelect(layer: WeatherLayer): void;
}): HTMLElement {
  let current = opts.initial;
  const div = document.createElement("div");
  div.className = "weather-toggle";
  div.setAttribute("role", "group");
  div.setAttribute("aria-label", "Weather");
  const buttons = new Map<WeatherLayer, HTMLButtonElement>();
  const paint = () => {
    for (const [id, btn] of buttons) {
      btn.setAttribute("aria-pressed", String(id === current));
    }
  };
  for (const b of BUTTONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = b.label;
    btn.title = b.title;
    btn.addEventListener("click", () => {
      if (b.id === current) return;
      current = b.id;
      paint();
      opts.onSelect(b.id);
    });
    div.appendChild(btn);
    buttons.set(b.id, btn);
  }
  paint();
  return div;
}

/** Add the weather switch to an already-drawn map.
 *
 * The tile layers go in the tile pane, under the track, so the balloon's
 * path is never buried by the weather it is flying through.
 */
export function addWeatherControl(map: L.Map, opts: WeatherOpts): void {
  const clouds = cloudTiles();
  let current = opts.initial;
  let layer: L.GridLayer | null = null;
  // A tile layer arrives asynchronously. By then the reader may have
  // switched again, or the whole map may have been torn down by a refresh,
  // and adding it either way would be wrong.
  let generation = 0;
  let dead = false;
  map.on("unload", () => { dead = true; });

  const toggle = buildWeatherToggle({
    initial: current,
    onSelect: (next) => {
      current = next;
      opts.onChange(next);
      void apply();
    },
  });
  // Otherwise a click on the switch also reaches the map underneath, and
  // a double tap on it zooms.
  L.DomEvent.disableClickPropagation(toggle);
  L.DomEvent.disableScrollPropagation(toggle);
  if (opts.into) {
    opts.into.appendChild(toggle);
  } else {
    const control = new L.Control({ position: opts.position ?? "topright" });
    control.onAdd = () => toggle;
    control.addTo(map);
  }

  async function apply(): Promise<void> {
    const token = ++generation;
    layer?.remove();
    layer = null;
    if (current === "off") return;
    const built = current === "rain" ? await rainLayer() : cloudLayer(clouds);
    // Stale by the time it resolved, or the map is gone: drop it.
    if (!built || dead || token !== generation) return;
    built.addTo(map);
    layer = built;
  }

  if (current !== "off") void apply();
}
