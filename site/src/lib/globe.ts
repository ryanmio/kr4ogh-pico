/** The globe: the same flight on an actual sphere.
 *
 * MapLibre with its globe projection, hung with the same imagery, labels
 * and weather tiles as the flat Leaflet map -- they are all plain epsg3857
 * rasters, and a sphere is just a different place to drape them. What the
 * globe does not carry is the per-point detail: the metric-coloured spots,
 * their tooltips and the legend stay on the flat map, which is where a
 * reader leans in close. This view is for the other end of the story --
 * a lap of the planet that looks like one.
 *
 * Imported lazily, and only ever by the live view: maplibre is several
 * times Leaflet's size, and the flat map must never pay for it.
 */

import {
  addProtocol, Map as MapGL, Marker, NavigationControl, setWorkerUrl,
  type IControl,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

// MapLibre 6 ships its worker as a sibling file and finds it relative to
// its own import.meta.url -- which survives neither Vite's dev pre-bundle
// nor the production build. Hand it a URL Vite has actually built: ?worker
// bundles the worker with its imports, &url yields the address.
setWorkerUrl(workerUrl);
import "maplibre-gl/dist/maplibre-gl.css";
import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import {
  fitRegion, LABEL_URL, TILE_ATTRIBUTION, TILE_URL, unwrapLons,
} from "./basemap";
import {
  buildWeatherToggle, cloudTiles, enhanceIrTile, rainTiles,
  type WeatherLayer, type WeatherTiles,
} from "./weather";
import type { FlightMeta, TrackPoint } from "./types";

/** Infrared tiles come through this scheme: `kr4ogh-ir://<satLon>|<url>`.
 * MapLibre substitutes {z}/{y}/{x} into the whole template before the
 * request reaches the handler, so the handler reads the tile coordinates
 * back off the end of the real URL, fetches it, runs the same per-pixel
 * work as the flat map's Leaflet layer, and hands back a PNG. */
const IR_PROTOCOL = "kr4ogh-ir";

/** A blank tile, for where GIBS has none. Tiles wholly off the disc are
 * simply absent from the product (a 404, not an empty image), which the
 * flat map's Leaflet layer swallows as an empty square; erroring here
 * instead would put a complaint in the console for every polar tile. */
let emptyTile: Promise<ArrayBuffer> | null = null;
function blankTile(): Promise<ArrayBuffer> {
  if (!emptyTile) {
    const c = new OffscreenCanvas(1, 1);
    // convertToBlob refuses a canvas that never had a context.
    c.getContext("2d");
    emptyTile = c.convertToBlob({ type: "image/png" })
      .then((b) => b.arrayBuffer());
  }
  return emptyTile;
}

addProtocol(IR_PROTOCOL, async (params, abort) => {
  const body = params.url.slice(IR_PROTOCOL.length + 3);
  const sep = body.indexOf("|");
  const satLon = Number(body.slice(0, sep));
  const src = body.slice(sep + 1);
  const zyx = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(src);
  const resp = await fetch(src, { signal: abort.signal });
  if (resp.status === 404) return { data: await blankTile() };
  if (!resp.ok) throw new Error(`tile HTTP ${resp.status}`);
  const bmp = await createImageBitmap(await resp.blob());
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, bmp.width, bmp.height);
  if (zyx) {
    enhanceIrTile(
      data.data, { x: bmp.width, y: bmp.height },
      { z: Number(zyx[1]), y: Number(zyx[2]), x: Number(zyx[3]) }, satLon,
    );
  }
  ctx.putImageData(data, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { data: await blob.arrayBuffer() };
});

const SPACE = "#050a14";

function baseStyle(): StyleSpecification {
  return {
    version: 8,
    projection: { type: "globe" },
    // The thin atmosphere is most of why the sphere reads as a planet. It
    // fades out as the reader closes in, where the globe itself hands over
    // to what is effectively a flat map.
    sky: {
      "sky-color": SPACE,
      "horizon-color": "#12203a",
      "fog-color": "#0b1020",
      "sky-horizon-blend": 0.7,
      "horizon-fog-blend": 0.6,
      "fog-ground-blend": 0.85,
      "atmosphere-blend": [
        "interpolate", ["linear"], ["zoom"], 0, 0.8, 5, 0.8, 7, 0,
      ],
    },
    sources: {
      basemap: {
        type: "raster", tiles: [TILE_URL], tileSize: 256, maxzoom: 17,
        attribution: TILE_ATTRIBUTION,
      },
      labels: {
        type: "raster", tiles: [LABEL_URL], tileSize: 256, maxzoom: 10,
      },
    },
    layers: [
      { id: "space", type: "background",
        paint: { "background-color": SPACE } },
      // The same knock-back the flat map applies with a CSS filter on the
      // basemap tiles, said in raster paint instead.
      { id: "basemap", type: "raster", source: "basemap",
        paint: { "raster-brightness-max": 0.82, "raster-saturation": -0.1 } },
      { id: "labels", type: "raster", source: "labels" },
    ],
  };
}

/** The launch dot, the cased track line and the newest fix, as style
 * sources and layers. Same colours and weights as the flat map, and the
 * same dark casing, for the same reason: over imagery or weather a lone
 * thin grey line vanishes. */
function addTrack(
  style: StyleSpecification, meta: FlightMeta, track: TrackPoint[],
  lons: number[],
): void {
  if (meta.launch_lat != null && meta.launch_lon != null) {
    style.sources.launch = {
      type: "geojson",
      data: {
        type: "Feature", properties: {},
        geometry: { type: "Point", coordinates: [meta.launch_lon, meta.launch_lat] },
      },
    };
    style.layers.push({
      id: "launch", type: "circle", source: "launch",
      paint: {
        "circle-radius": 8, "circle-color": "#0b1020",
        "circle-stroke-color": "#e2e8f0", "circle-stroke-width": 2,
      },
    });
  }
  if (!track.length) return;
  style.sources.flight = {
    type: "geojson",
    data: {
      type: "Feature", properties: {},
      geometry: {
        type: "LineString",
        coordinates: track.map((p, i) => [lons[i]!, p.lat]),
      },
    },
  };
  style.sources.here = {
    type: "geojson",
    data: {
      type: "Feature", properties: {},
      geometry: {
        type: "Point",
        coordinates: [lons[lons.length - 1]!, track[track.length - 1]!.lat],
      },
    },
  };
  style.layers.push(
    { id: "track-casing", type: "line", source: "flight",
      paint: { "line-color": "#0b1020", "line-width": 7, "line-opacity": 0.5 } },
    { id: "track", type: "line", source: "flight",
      paint: { "line-color": "#e2e8f0", "line-width": 2.6, "line-opacity": 0.9 } },
    // A solid dot for the newest fix; the pulsing ring rides on top as a
    // DOM marker, since only the DOM can animate. Unlike the flat map there
    // is no metric-coloured point underneath to keep visible, so the dot is
    // filled with the track's own colour.
    { id: "here", type: "circle", source: "here",
      paint: {
        "circle-radius": 6, "circle-color": "#e2e8f0",
        "circle-stroke-color": "#0b1020", "circle-stroke-width": 1.5,
      } },
  );
}

/** Open on the flat map's framing: the whole track plus room around the
 * balloon (fitRegion, shared numbers). A track that has lapped the planet
 * cannot be fitted -- the fit is the planet -- so stand back and put the
 * balloon in the middle of the face instead. */
function aimCamera(
  map: MapGL, meta: FlightMeta, track: TrackPoint[],
  lons: number[], overlaid: boolean,
): void {
  if (!track.length) {
    if (meta.launch_lat != null && meta.launch_lon != null) {
      map.jumpTo({ center: [meta.launch_lon, meta.launch_lat], zoom: 4 });
    } else {
      map.jumpTo({ center: [-40, 25], zoom: 1 });
    }
    return;
  }
  const r = fitRegion(track.map((p) => p.lat), lons);
  if (r.east - r.west >= 300) {
    map.jumpTo({
      center: [lons[lons.length - 1]!, track[track.length - 1]!.lat],
      zoom: 1.3,
    });
    return;
  }
  map.fitBounds(
    [[r.west, Math.max(r.south, -85)], [r.east, Math.min(r.north, 85)]],
    {
      duration: 0,
      // A young flight is a dot; fitting it exactly would mean opening on a
      // wall of imagery with no planet in sight.
      maxZoom: 9,
      // In the full-page view the card column floats over the left edge and
      // the header over the top, so the fit leaves them room.
      padding: overlaid
        ? { top: 64, left: 330, bottom: 24, right: 24 }
        : { top: 24, left: 24, bottom: 24, right: 24 },
    },
  );
}

export interface GlobeWeather {
  /** Longitude of the balloon now: it picks the geostationary satellite. */
  lon: number;
  /** Layer to start on, so a rebuilt globe comes back the way it went away. */
  initial: WeatherLayer;
  /** Called on every change, for the caller to remember across rebuilds. */
  onChange(layer: WeatherLayer): void;
  /** Render the switch into this element instead of the globe's corner. */
  into?: HTMLElement;
}

export interface GlobeOpts {
  /** True when the card column and header float over the map, so the fit
   * leaves them room. */
  overlaid?: boolean;
  weather?: GlobeWeather;
}

export interface GlobeHandle {
  remove(): void;
  getCamera(): {
    center: [number, number]; zoom: number; bearing: number; pitch: number;
  };
  setCamera(cam: ReturnType<GlobeHandle["getCamera"]>): void;
  /** Fires on reader-initiated movement only, never on the camera being
   * aimed by code -- the same contract the flat map's caller relies on. */
  onInteract(fn: () => void): void;
  /** Put a caller-built control in the globe's bottom-left corner. */
  addCorner(el: HTMLElement): void;
}

function cornerWrap(el: HTMLElement): IControl {
  const wrap = document.createElement("div");
  wrap.className = "maplibregl-ctrl";
  wrap.appendChild(el);
  return { onAdd: () => wrap, onRemove: () => wrap.remove() };
}

/** The same weather switch as the flat map, applying the same products as
 * raster sources: radar as published, infrared through the tile protocol
 * above. State handling mirrors addWeatherControl, and for the same
 * reasons: tiles arrive asynchronously, and by then the reader may have
 * switched again or the globe may be gone. */
function addGlobeWeather(map: MapGL, opts: GlobeWeather): void {
  const WEATHER_ID = "weather";
  const clouds = cloudTiles(opts.lon);
  // A remembered "clouds" is honoured only where there is a satellite to
  // show; elsewhere the globe opens clean rather than blank-with-a-layer-on.
  let current: WeatherLayer =
    opts.initial === "clouds" && !clouds ? "off" : opts.initial;
  let generation = 0;
  let dead = false;
  map.on("remove", () => { dead = true; });
  // Adding a source before the style has loaded throws; every apply waits
  // behind this gate, which is already open from the second one on.
  const ready = new Promise<void>((res) => map.on("load", () => res()));

  const toggle = buildWeatherToggle({
    cloudsAvailable: !!clouds,
    initial: current,
    onSelect: (next) => {
      current = next;
      opts.onChange(next);
      void apply();
    },
  });
  if (opts.into) opts.into.appendChild(toggle);
  else map.addControl(cornerWrap(toggle), "bottom-left");

  async function apply(): Promise<void> {
    const token = ++generation;
    await ready;
    if (dead || token !== generation) return;
    if (map.getLayer(WEATHER_ID)) map.removeLayer(WEATHER_ID);
    if (map.getSource(WEATHER_ID)) map.removeSource(WEATHER_ID);
    if (current === "off") return;
    const t: WeatherTiles | null =
      current === "rain" ? await rainTiles() : clouds;
    if (!t || dead || token !== generation) return;
    const url = current === "clouds" && clouds
      ? `${IR_PROTOCOL}://${clouds.satLon}|${t.url}`
      : t.url;
    map.addSource(WEATHER_ID, {
      type: "raster", tiles: [url], tileSize: 256,
      maxzoom: t.maxNativeZoom, attribution: t.attribution,
    });
    // Over the labels, under the track -- the flat map's stacking.
    const beforeId = ["launch", "track-casing"]
      .find((id) => map.getLayer(id));
    map.addLayer(
      { id: WEATHER_ID, type: "raster", source: WEATHER_ID,
        paint: { "raster-opacity": t.opacity } },
      beforeId,
    );
  }

  if (current !== "off") void apply();
}

/** Draw the globe and return a handle for the caller that re-renders. Can
 * throw where WebGL is refused; the caller falls back to the flat map. */
export function renderGlobe(
  el: HTMLElement, meta: FlightMeta, track: TrackPoint[],
  opts: GlobeOpts = {},
): GlobeHandle {
  el.classList.add("fv-map-fill", "fv-globe");
  const lons = unwrapLons(track);
  const style = baseStyle();
  addTrack(style, meta, track, lons);

  const map = new MapGL({
    container: el,
    style,
    attributionControl: { compact: false },
  });
  // A tile hiccup (a weather source down, a labels tile missing) otherwise
  // lands in console.error, which the browser check would count as ours.
  map.on("error", (e) => console.warn("globe:", e.error?.message ?? e.error));
  map.addControl(
    new NavigationControl({ showCompass: false }), "top-right");

  aimCamera(map, meta, track, lons, !!opts.overlaid);

  if (track.length) {
    // The pulsing "you are here", same CSS as the flat map's.
    const icon = document.createElement("div");
    icon.className = "last-pos-icon";
    icon.style.width = icon.style.height = "22px";
    icon.innerHTML = '<span class="last-pos-pulse"></span>';
    new Marker({ element: icon })
      .setLngLat([lons[lons.length - 1]!, track[track.length - 1]!.lat])
      .addTo(map);
  }

  if (opts.weather) addGlobeWeather(map, opts.weather);

  const interactFns: (() => void)[] = [];
  const interact = () => { for (const f of interactFns) f(); };
  // originalEvent separates a reader's drag, pinch or scroll from the
  // camera being aimed by code; the zoom buttons ease the camera with no
  // originalEvent, so they are listened to directly.
  map.on("movestart", (e) => { if (e.originalEvent) interact(); });
  el.querySelector(".maplibregl-ctrl-zoom-in")
    ?.parentElement?.addEventListener("click", interact);

  return {
    remove: () => {
      map.remove();
      el.classList.remove("fv-map-fill", "fv-globe");
    },
    getCamera: () => {
      const c = map.getCenter();
      return {
        center: [c.lng, c.lat], zoom: map.getZoom(),
        bearing: map.getBearing(), pitch: map.getPitch(),
      };
    },
    setCamera: (cam) => map.jumpTo(cam),
    onInteract: (fn) => { interactFns.push(fn); },
    addCorner: (ctl) => { map.addControl(cornerWrap(ctl), "bottom-left"); },
  };
}
