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
 * Live flights only. An archived flight is months old and today's weather
 * over its track would be a lie told in pictures.
 */

import L from "leaflet";

export type WeatherLayer = "off" | "rain" | "clouds";

const STORAGE_KEY = "kr4ogh-weather";

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

/** NASA GIBS serves band 13 ("clean infrared", cloud-top brightness
 * temperature) from three geostationary satellites, keyless, in the map's
 * own projection, on a ten-minute cadence about twenty minutes behind real
 * time.
 *
 * The layer is already an enhanced infrared product, not a plain grey
 * picture. Its colour map (Clean_Longwave_Infrared_Window_Band) is grey from
 * about +57 C down to -19 C, and colour below that: cyan, blue, green,
 * yellow, orange, red, magenta, on down past -90 C. Those colours are the
 * storms, and they are the whole point of the layer. */
interface GeoSat {
  layer: string;
  name: string;
  /** Sub-satellite longitude. */
  lon: number;
}

const GEO_SATS: GeoSat[] = [
  { layer: "GOES-East_ABI_Band13_Clean_Infrared", name: "GOES-East", lon: -75.2 },
  { layer: "GOES-West_ABI_Band13_Clean_Infrared", name: "GOES-West", lon: -137.0 },
  { layer: "Himawari_AHI_Band13_Clean_Infrared", name: "Himawari", lon: 140.7 },
];

/** Beyond this far from a satellite's sub-point the disc is edge-on and the
 * imagery is smeared to uselessness, or absent. GIBS carries nothing over
 * Europe, Africa or the Indian Ocean, so a flight there has no cloud layer
 * at all — better to say so than to offer a button that draws nothing. */
const GEO_LIMIT_DEG = 65;

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
 * sit past 70° from every sub-point and are cut by the same knife. */
const DISC_FULL_COS = Math.cos((60 * Math.PI) / 180);
const DISC_EDGE_COS = Math.cos((70 * Math.PI) / 180);

/** How far back to ask for, and the product's cadence.
 *
 * TIME=default is the obvious choice and the wrong one. It resolves to
 * whatever the node serving the request has finished ingesting, which is not
 * the same answer twice in a row -- two probes seconds apart came back 12:30
 * and 12:50 -- so a single map ends up drawn from several different times,
 * with a tile-shaped hole wherever one of them is not ready yet.
 *
 * Frames fill in from the newest backwards. Sampling nine tiles across zooms
 * 3 to 6: the current slot and the one before it were entirely absent, the
 * one 20 minutes back was three-ninths there, and everything 30 minutes or
 * older was complete. So take the newest slot at least this far back and ask
 * for it by name. One frame, one moment, no holes, at the cost of half an
 * hour of freshness -- which for cloud tops over an ocean is nothing, and a
 * good trade for a picture that is all there. */
const GIBS_LAG_MIN = 40;
const GIBS_STEP_MIN = 10;

/** The newest frame old enough to be complete, as a WMTS timestamp. */
function gibsFrameTime(now: number = Date.now()): string {
  const step = GIBS_STEP_MIN * 60_000;
  const slot = Math.floor((now - GIBS_LAG_MIN * 60_000) / step) * step;
  return `${new Date(slot).toISOString().slice(0, 19)}Z`;
}

function pickSatellite(lon: number): GeoSat | null {
  let best: GeoSat | null = null;
  let bestOff = Infinity;
  for (const sat of GEO_SATS) {
    const off = Math.abs(((lon - sat.lon + 540) % 360) - 180);
    if (off < bestOff) { best = sat; bestOff = off; }
  }
  return bestOff <= GEO_LIMIT_DEG ? best : null;
}

/** Warmest cloud that gets drawn at all, and the coldest grey the colour map
 * uses before it starts colouring. Between the two the layer fades in as
 * white, which is the cloud field; below it GIBS' own colours take over,
 * which is the weather. */
const GREY_CLEAR_C = 5;
const GREY_COLD_C = -18.4;

/** Grey level to brightness temperature, from the published colour map: it
 * is linear over the grey range, 196 at -18.4 C down to 9 at +53.6 C. */
const GREY_AT_COLD = 196;
const C_PER_GREY = (53.6 - GREY_COLD_C) / (GREY_AT_COLD - 9);

function greyToC(grey: number): number {
  return GREY_COLD_C + (GREY_AT_COLD - grey) * C_PER_GREY;
}

/** Peak opacity of the white cloud field. The colours are drawn harder than
 * this: cloud is context, a storm is the message. */
const CLOUD_ALPHA = 0.62;
const STORM_ALPHA = 0.92;

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

/** Turn a tile of the published product into something that can be laid over
 * a map without burying it.
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
  const span = GREY_CLEAR_C - GREY_COLD_C;
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
    const t = (GREY_CLEAR_C - greyToC(r)) / span;
    px[i + 3] = t <= 0 ? 0 : Math.round(255 * CLOUD_ALPHA * Math.min(t, 1));
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

/** A tile layer that runs `enhance` and the disc mask over every tile
 * before it is shown.
 *
 * GIBS sends `access-control-allow-origin: *`, so an anonymous crossOrigin
 * image does not taint the canvas and the pixels can be read back. If a
 * browser refuses anyway the tile is dropped rather than drawn raw: a blank
 * square is better than an opaque grey one over the whole map.
 */
const EnhancedIrLayer = L.TileLayer.extend({
  createTile(this: L.TileLayer, coords: L.Coords, done: L.DoneCallback) {
    const size = this.getTileSize();
    const canvas = document.createElement("canvas");
    canvas.width = size.x;
    canvas.height = size.y;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return done(undefined, canvas);
      ctx.drawImage(img, 0, 0, size.x, size.y);
      let data: ImageData;
      try {
        data = ctx.getImageData(0, 0, size.x, size.y);
      } catch {
        ctx.clearRect(0, 0, size.x, size.y);
        return done(undefined, canvas);
      }
      enhance(data.data);
      const satLon = (this.options as { satLon?: number }).satLon;
      if (satLon !== undefined) maskDisc(data.data, size, coords, satLon);
      ctx.putImageData(data, 0, 0);
      done(undefined, canvas);
    };
    img.onerror = () => done(new Error("tile failed"), canvas);
    img.src = this.getTileUrl(coords);
    return canvas;
  },
}) as new (
  url: string, options?: L.TileLayerOptions & { satLon?: number },
) => L.TileLayer;

export interface CloudTiles extends WeatherTiles {
  /** Sub-satellite longitude, for the disc mask. */
  satLon: number;
}

/** The infrared product for this part of the world, or null where no
 * geostationary satellite covers it. The tiles still need the per-pixel
 * treatment: enhanceIrTile, which the flat map runs in a Leaflet layer and
 * the globe runs in a tile protocol. */
export function cloudTiles(lon: number): CloudTiles | null {
  const sat = pickSatellite(lon);
  if (!sat) return null;
  const time = gibsFrameTime();
  return {
    url:
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" +
      `${sat.layer}/default/${time}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`,
    satLon: sat.lon,
    opacity: 1,
    // The product itself stops at zoom 6.
    maxNativeZoom: 6,
    attribution:
      `${sat.name} infrared ${time.slice(11, 16)} UTC &copy; ` +
      '<a href="https://worldview.earthdata.nasa.gov/">NASA GIBS</a>',
  };
}

/** The whole treatment for one epsg3857 infrared tile: per-pixel alpha from
 * the data, then the disc mask. */
export function enhanceIrTile(
  px: Uint8ClampedArray, size: { x: number; y: number },
  coords: { x: number; y: number; z: number }, satLon: number,
): void {
  enhance(px);
  maskDisc(px, size, coords, satLon);
}

function cloudLayer(t: CloudTiles): L.TileLayer {
  return new EnhancedIrLayer(t.url, {
    className: "weather-tiles weather-clouds",
    satLon: t.satLon,
    maxNativeZoom: t.maxNativeZoom,
    maxZoom: 16,
    attribution: t.attribution,
  });
}

// ---------- the control ----------

export interface WeatherOpts {
  /** Longitude of the balloon now: it picks the geostationary satellite. */
  lon: number;
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
      "Infrared cloud tops, about forty minutes old. White is cloud; the " +
      "colours are tops colder than about -33 C, which is what a storm " +
      "looks like from above. Works over the ocean, where radar does not.",
  },
];

/** The three-way switch itself, plain DOM so both renderers can use it: the
 * flat map puts it in a Leaflet corner or the top strip, the globe in its
 * own corner. It owns its pressed state; applying the layers is the
 * caller's half. */
export function buildWeatherToggle(opts: {
  cloudsAvailable: boolean;
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
    // Nowhere on earth for it to draw: shown, so the reason is visible in
    // the title, but not offered.
    btn.title = b.id === "clouds" && !opts.cloudsAvailable
      ? "No geostationary infrared covers this part of the world"
      : b.title;
    btn.disabled = b.id === "clouds" && !opts.cloudsAvailable;
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
  const clouds = cloudTiles(opts.lon);
  // A remembered "clouds" is honoured only where there is a satellite to
  // show; elsewhere the map opens clean rather than blank-with-a-layer-on.
  let current: WeatherLayer =
    opts.initial === "clouds" && !clouds ? "off" : opts.initial;
  let layer: L.TileLayer | null = null;
  // A tile layer arrives asynchronously. By then the reader may have
  // switched again, or the whole map may have been torn down by a refresh,
  // and adding it either way would be wrong.
  let generation = 0;
  let dead = false;
  map.on("unload", () => { dead = true; });

  const toggle = buildWeatherToggle({
    cloudsAvailable: !!clouds,
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
    const built = current === "rain"
      ? await rainLayer()
      : clouds ? cloudLayer(clouds) : null;
    // Stale by the time it resolved, or the map is gone: drop it.
    if (!built || dead || token !== generation) return;
    built.addTo(map);
    layer = built;
  }

  if (current !== "off") void apply();
}
