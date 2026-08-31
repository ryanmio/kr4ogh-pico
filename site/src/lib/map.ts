/** Leaflet track map. Points are colored by altitude; longitudes are
 * unwrapped so a Pacific crossing draws as one continuous line instead of
 * jumping across the antimeridian. */

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { fmtUtc } from "./format";
import { altitude as fmtAltitude, type Units } from "./units";
import type { FlightMeta, TrackPoint } from "./types";

// Keyless dark basemap. CARTO's dark_all was here first, but CARTO now
// requires an API key and serves watermarked "API KEY REQUIRED" tiles
// without one, which is unusable on a public page. Esri's dark canvas needs
// no key and suits the dark theme; attribution is required and given below.
const TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/" +
  "World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const TILE_ATTRIBUTION =
  'Tiles &copy; <a href="https://www.esri.com/">Esri</a>, ' +
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' +
  " contributors";

/** Blue (low) through cyan to yellow (high). */
function altitudeColor(alt: number, lo: number, hi: number): string {
  const stops: [number, number, number][] = [
    [59, 130, 246],
    [34, 211, 238],
    [253, 224, 71],
  ];
  const f = hi > lo ? (alt - lo) / (hi - lo) : 0.5;
  const pos = Math.min(Math.max(f, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(pos), stops.length - 2);
  const k = pos - i;
  const mix = stops[i]!.map((c, ch) => Math.round(c + (stops[i + 1]![ch]! - c) * k));
  return `rgb(${mix.join(",")})`;
}

/** Shift each longitude by ±360 as needed so consecutive points never jump
 * more than 180°. */
function unwrapLons(track: TrackPoint[]): number[] {
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

/** The view: the whole track, plus room around where the balloon is now. */
function fitBoundsFor(latlngs: L.LatLng[]): L.LatLngBounds {
  const b = L.latLngBounds(latlngs).pad(FIT_PAD);
  const here = latlngs[latlngs.length - 1]!;
  const span = Math.max(b.getEast() - b.getWest(), b.getNorth() - b.getSouth());
  const r = Math.min(POS_ROOM * span, POS_ROOM_MAX_DEG);
  return b
    .extend(L.latLng(here.lat - r, here.lng - r))
    .extend(L.latLng(here.lat + r, here.lng + r));
}

/** Phones get a square map at most.
 *
 * A flight that has not spread out yet asks for a tall box, and on a portrait
 * phone the viewport ceiling below is most of the screen: the map alone fills
 * it and the numbers are a scroll away. A square is the widest box that still
 * leaves the stats in reach, and it costs nothing on a track this shape --
 * the fit is on longitude, so the extra height was slack anyway. */
const NARROW_PX = 700;

/** Size the map box to the view it has to show. A float that has wrapped the
 * globe several times is fitted on longitude, so its height is pinned to the
 * world's own height at that zoom: any taller and the extra is empty space off
 * the top and bottom of the map. A flight still near its launch point is the
 * other way round and gets a tall box.
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
  units: Units = "metric",
): L.Map {
  const lons = unwrapLons(track);
  const latlngs = track.map((p, i) => L.latLng(p.lat, lons[i]!));
  // Worked out before the map exists, because the box has to be the right
  // height before Leaflet measures it.
  const fitted = latlngs.length > 0 ? fitBoundsFor(latlngs) : null;
  if (fitted) fitHeightToBounds(el, fitted);

  const map = L.map(el, {
    preferCanvas: true,
    worldCopyJump: false,
    zoomControl: true,
    attributionControl: true,
    // Fractional zoom, so a fitted track fills the box exactly instead of
    // snapping to the next zoom out and leaving slack around the world.
    zoomSnap: 0,
    maxBoundsViscosity: 1,
  });
  // Classed so the CSS that knocks the basemap back does not also dim a
  // weather layer drawn over it; see global.css.
  L.tileLayer(TILE_URL, {
    attribution: TILE_ATTRIBUTION, maxZoom: 16, className: "basemap-tiles",
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

  L.polyline(latlngs, { color: "#64748b", weight: 1.5, opacity: 0.8 }).addTo(map);

  // The polyline above carries the full track; interactive per-point markers
  // are thinned on long flights so a two-month, several-thousand-point track
  // stays responsive. The most recent point is always kept.
  const altLo = Math.min(...track.map((p) => p.altitude_m));
  const altHi = Math.max(...track.map((p) => p.altitude_m));
  const step = Math.max(1, Math.ceil(track.length / 900));
  track.forEach((p, i) => {
    if (i % step !== 0 && i !== track.length - 1) return;
    L.circleMarker(latlngs[i]!, {
      radius: 3.5,
      stroke: false,
      fillColor: altitudeColor(p.altitude_m, altLo, altHi),
      fillOpacity: 0.95,
    }).bindTooltip(
      `${fmtUtc(p.utc)}<br>${p.grid6} · ${fmtAltitude(p.altitude_m, units).text}` +
      ` · ${p.voltage_v.toFixed(2)} V`,
    ).addTo(map);
  });

  // The most recent position gets a pulsing ring (a DOM icon, since the
  // canvas renderer cannot animate). It is hollow on purpose: the
  // altitude-coloured dot for this same fix is underneath and has to stay
  // readable, or the newest point is the one point whose altitude you cannot
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

  map.fitBounds(fitted!);
  coverBoxWithWorld(map, el, fitted!);

  // Keep the world covering the box at every zoom and pan: no zooming out
  // past the point where the world is shorter than the box, and no panning
  // off the top or bottom of it. Otherwise both leave bare strips. Longitude
  // is left loose, with room for the wrapped copies a multi-lap track needs.
  map.setMinZoom(Math.log2(el.clientHeight / 256));
  map.setMaxBounds(L.latLngBounds(
    L.latLng(-85, Math.min(...lons) - 360),
    L.latLng(85, Math.max(...lons) + 360),
  ));

  const legend = new L.Control({ position: "bottomright" });
  legend.onAdd = () => {
    const div = L.DomUtil.create("div", "map-legend");
    div.innerHTML =
      `<span>${fmtAltitude(altLo, units).text}</span>` +
      '<span class="map-legend-bar"></span>' +
      `<span>${fmtAltitude(altHi, units).text}</span>`;
    return div;
  };
  legend.addTo(map);
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
