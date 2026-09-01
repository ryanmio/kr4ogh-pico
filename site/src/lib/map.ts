/** Leaflet track map. Points are colored by a selectable metric (altitude by
 * default); longitudes are unwrapped so a Pacific crossing draws as one
 * continuous line instead of jumping across the antimeridian. */

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  fitRegion, LABEL_URL, TILE_ATTRIBUTION, TILE_URL, unwrapLons,
} from "./basemap";
import { fmtUtc } from "./format";
import { METRICS, rampColor, rampGradient, type MetricKey } from "./metrics";
import { altitude as fmtAltitude, speed as fmtSpeed, type Units } from "./units";
import type { FlightMeta, TrackPoint } from "./types";

export interface MapOptions {
  units?: Units;
  /** What the spots are colored by. */
  metric?: MetricKey;
  /** "fit" sizes the box to the track (article-style pages); "fill" leaves
   * the box alone because CSS already makes it fill its space (the live
   * full-page view). */
  sizing?: "fit" | "fill";
  /** Render the legend into this element instead of a map corner. The
   * desktop live view lines it up in the top bar with the other controls. */
  legendInto?: HTMLElement;
}

/** The view: the whole track, plus room around where the balloon is now.
 * The numbers live in basemap.ts so the globe opens on the same framing. */
function fitBoundsFor(latlngs: L.LatLng[]): L.LatLngBounds {
  const r = fitRegion(latlngs.map((p) => p.lat), latlngs.map((p) => p.lng));
  return L.latLngBounds(L.latLng(r.south, r.west), L.latLng(r.north, r.east));
}

/** Phones get a square map at most.
 *
 * A flight that has not spread out yet asks for a tall box, and on a portrait
 * phone the viewport ceiling below is most of the screen: the map alone fills
 * it and the numbers are a scroll away. A square is the widest box that still
 * leaves the stats in reach, and it costs nothing on a track this shape --
 * the fit is on longitude, so the extra height was slack anyway. */
const NARROW_PX = 700;

/** Size the map box to the view it has to show ("fit" pages only). A float
 * that has wrapped the globe several times is fitted on longitude, so its
 * height is pinned to the world's own height at that zoom: any taller and
 * the extra is empty space off the top and bottom of the map. A flight still
 * near its launch point is the other way round and gets a tall box.
 *
 * It takes the fitted bounds rather than the raw track so that the padding
 * and the room around the balloon are counted once, here and in the fit, and
 * cannot drift apart. */
function fitHeightToBounds(el: HTMLElement, fitted: L.LatLngBounds): void {
  const worldsWide = (fitted.getEast() - fitted.getWest()) / 360;
  const width = el.clientWidth || 900;
  const worldHeightPx = width / Math.max(worldsWide, 1e-6);
  // Ceiling keeps the stat strip under the map within reach of the first screen.
  const narrow = window.innerWidth < NARROW_PX;
  const ceiling = narrow
    ? Math.min(width, window.innerHeight * 0.62)
    : window.innerHeight * 0.62;
  // The floor has to stay under the ceiling, or a very narrow screen would be
  // forced taller than square by the floor itself.
  const floor = narrow ? Math.min(240, ceiling) : 300;
  el.style.height =
    `${Math.round(Math.max(floor, Math.min(ceiling, worldHeightPx)))}px`;
}

/** Draw the track and return the Leaflet map, so a caller that re-renders
 * can dispose of it with map.remove(). Leaflet stamps the container with a
 * _leaflet_id and refuses to initialise it twice, so simply emptying the
 * element and calling this again throws "Map container is already
 * initialized" and leaves a blank box. */
export function renderMap(
  el: HTMLElement, meta: FlightMeta, track: TrackPoint[],
  opts: MapOptions = {},
): L.Map {
  const units = opts.units ?? "metric";
  const metric = METRICS[opts.metric ?? "altitude"];
  const fill = opts.sizing === "fill";

  const lons = unwrapLons(track);
  const latlngs = track.map((p, i) => L.latLng(p.lat, lons[i]!));
  // Worked out before the map exists, because on "fit" pages the box has to
  // be the right height before Leaflet measures it.
  const fitted = latlngs.length > 0 ? fitBoundsFor(latlngs) : null;
  if (fitted && !fill) fitHeightToBounds(el, fitted);

  const map = L.map(el, {
    preferCanvas: true,
    worldCopyJump: false,
    // In the full-page view the top corners are under the floating header,
    // so the zoom control moves to the right edge below it.
    zoomControl: !fill,
    attributionControl: true,
    // Fractional zoom, so a fitted track fills the box exactly instead of
    // snapping to the next zoom out and leaving slack around the world.
    zoomSnap: 0,
    maxBoundsViscosity: 1,
  });
  if (fill) L.control.zoom({ position: "topright" }).addTo(map);
  // Classed so CSS can treat the basemap, the labels and a weather layer
  // differently; see global.css.
  L.tileLayer(TILE_URL, {
    attribution: TILE_ATTRIBUTION, maxZoom: 17, className: "basemap-tiles",
  }).addTo(map);
  L.tileLayer(LABEL_URL, {
    maxZoom: 17, maxNativeZoom: 10, className: "label-tiles",
  }).addTo(map);

  if (meta.launch_lat != null && meta.launch_lon != null) {
    L.circleMarker([meta.launch_lat, meta.launch_lon], {
      radius: 6, color: "#e2e8f0", weight: 2, fillColor: "#0b1020",
      fillOpacity: 1,
    }).bindTooltip(`Launch${meta.launch_utc ? " · " + fmtUtc(meta.launch_utc) : ""}`)
      .addTo(map);
  }

  if (track.length === 0) {
    if (meta.launch_lat != null && meta.launch_lon != null) {
      map.setView([meta.launch_lat, meta.launch_lon], 6);
    } else {
      map.setView([25, -40], 2);
    }
    return map;
  }

  // A dark casing under a light line: over satellite imagery, and over a
  // weather layer, a single thin grey line vanishes. The casing separates
  // the path from whatever is beneath it.
  L.polyline(latlngs, { color: "#0b1020", weight: 5, opacity: 0.5 }).addTo(map);
  L.polyline(latlngs, { color: "#e2e8f0", weight: 1.8, opacity: 0.9 }).addTo(map);

  // The polylines above carry the full track; interactive per-point markers
  // are thinned on long flights so a two-month, several-thousand-point track
  // stays responsive. The most recent point is always kept.
  const raws = track.map((p) => metric.raw(p));
  const lo = Math.min(...raws);
  const hi = Math.max(...raws);
  const step = Math.max(1, Math.ceil(track.length / 900));
  track.forEach((p, i) => {
    if (i % step !== 0 && i !== track.length - 1) return;
    L.circleMarker(latlngs[i]!, {
      radius: 4,
      color: "rgba(11, 16, 32, 0.6)",
      weight: 1,
      fillColor: rampColor(metric.ramp, hi > lo ? (raws[i]! - lo) / (hi - lo) : 0.5),
      fillOpacity: 1,
    }).bindTooltip(
      `${fmtUtc(p.utc)}<br>${fmtAltitude(p.altitude_m, units).text}` +
      ` · ${fmtSpeed(p.speed_kt, units).text} · ${p.voltage_v.toFixed(2)} V`,
    ).addTo(map);
  });

  // The most recent position gets a pulsing ring (a DOM icon, since the
  // canvas renderer cannot animate). It is hollow on purpose: the
  // metric-coloured dot for this same fix is underneath and has to stay
  // readable, or the newest point is the one point whose value you cannot
  // see.
  L.marker(latlngs[latlngs.length - 1]!, {
    icon: L.divIcon({
      className: "last-pos-icon",
      html: '<span class="last-pos-pulse"></span>',
      iconSize: [16, 16],
    }),
    keyboard: false,
    interactive: false,
  }).addTo(map);

  // In the full-page view the card column floats over the map's left edge
  // and the header over its top, so the fit leaves them room; otherwise the
  // launch end of the track starts life hidden under the cards. On a narrow
  // screen the cards are below the map, not over it, so no room is needed.
  const overlaid = fill && el.clientWidth >= 900;
  map.fitBounds(fitted!, overlaid
    ? { paddingTopLeft: [330, 64], paddingBottomRight: [24, 24] }
    : undefined);
  if (!fill) coverBoxWithWorld(map, el, fitted!);

  // Keep the world covering the box at every zoom and pan: no zooming out
  // past the point where the world is shorter than the box, and no panning
  // off the top or bottom of it. Otherwise both leave bare strips. Longitude
  // is left loose, with room for the wrapped copies a multi-lap track needs.
  map.setMinZoom(Math.log2(el.clientHeight / 256));
  map.setMaxBounds(L.latLngBounds(
    L.latLng(-85, Math.min(...lons) - 360),
    L.latLng(85, Math.max(...lons) + 360),
  ));

  // The legend names the metric the spots are colored by. The desktop live
  // view hands in a slot in its top bar; a phone drops it to the bottom
  // edge, where it does not stack halfway down a short map; article-style
  // pages keep their old corner.
  const legendDiv = L.DomUtil.create("div", "map-legend");
  legendDiv.innerHTML =
    `<span class="map-legend-name">${metric.label}</span>` +
    `<span>${metric.fmt(lo, units)}</span>` +
    `<span class="map-legend-bar" style="background:${rampGradient(metric.ramp)}"></span>` +
    `<span>${metric.fmt(hi, units)}</span>`;
  if (opts.legendInto) {
    opts.legendInto.appendChild(legendDiv);
  } else {
    const legend = new L.Control({
      position: fill ? "bottomleft" : "bottomright",
    });
    legend.onAdd = () => legendDiv;
    legend.addTo(map);
  }
  return map;
}

/** Keep tiles covering the whole box. A globe-spanning track is fitted on
 * longitude, so the world can end up no taller than the box, and fitBounds
 * then centres on the track's latitude, which pushes the world down and
 * leaves a bare strip along the top. Pin the box to the world's height and
 * centre on the equator: at that zoom it is the only position where the map
 * reaches both edges. */
function coverBoxWithWorld(
  map: L.Map, el: HTMLElement, fitted: L.LatLngBounds,
): void {
  const worldPx = map.getPixelWorldBounds().getSize().y;
  if (worldPx > el.clientHeight + 1) return;
  el.style.height = `${Math.round(Math.max(worldPx, 260))}px`;
  map.invalidateSize({ animate: false });
  map.setView([0, fitted.getCenter().lng], map.getZoom(), { animate: false });
}

/** Put a caller-built control (the flat/globe switch) in a map corner, with
 * the map's own gestures under it disabled the way Leaflet's controls do:
 * otherwise a click on it also pans-or-zooms whatever is beneath. */
export function addCornerControl(
  map: L.Map, el: HTMLElement, position: L.ControlPosition,
): void {
  const control = new L.Control({ position });
  control.onAdd = () => {
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
    return el;
  };
  control.addTo(map);
}
