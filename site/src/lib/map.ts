/** Leaflet track map. Points are colored by altitude; longitudes are
 * unwrapped so a Pacific crossing draws as one continuous line instead of
 * jumping across the antimeridian. */

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { fmtInt, fmtUtc } from "./format";
import type { FlightMeta, TrackPoint } from "./types";

// Free-tier basemap that suits a dark site; OSM data underneath.
const TILE_URL =
  "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' +
  ' contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

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

// Fraction of the track's span added as breathing room around it, matched
// between the height calculation and the fitBounds call below.
const FIT_PAD = 0.06;

/** Size the map box to the track it has to show. A float that has wrapped the
 * globe several times is fitted on longitude, so its height is pinned to the
 * world's own height at that zoom: any taller and the extra is empty space off
 * the top and bottom of the map. A flight still near its launch point is the
 * other way round and gets a tall box. */
function fitHeightToTrack(el: HTMLElement, latlngs: L.LatLng[]): void {
  const lons = latlngs.map((p) => p.lng);
  const worldsWide =
    ((Math.max(...lons) - Math.min(...lons)) * (1 + 2 * FIT_PAD)) / 360;
  const worldHeightPx = (el.clientWidth || 900) / Math.max(worldsWide, 1e-6);
  // Ceiling keeps the stat strip under the map within reach of the first screen.
  const ceiling = window.innerHeight * 0.62;
  el.style.height =
    `${Math.round(Math.max(300, Math.min(ceiling, worldHeightPx)))}px`;
}

export function renderMap(
  el: HTMLElement, meta: FlightMeta, track: TrackPoint[],
): void {
  const lons = unwrapLons(track);
  const latlngs = track.map((p, i) => L.latLng(p.lat, lons[i]!));
  if (latlngs.length > 0) fitHeightToTrack(el, latlngs);

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
  L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 12 }).addTo(map);

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
    return;
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
      `${fmtUtc(p.utc)}<br>${p.grid6} · ${fmtInt(p.altitude_m)} m · ` +
      `${p.speed_kt} kt · ${p.voltage_v.toFixed(2)} V`,
    ).addTo(map);
  });

  // The most recent position gets a visible pulse (a DOM icon, since the
  // canvas renderer cannot animate).
  L.marker(latlngs[latlngs.length - 1]!, {
    icon: L.divIcon({
      className: "last-pos-icon",
      html: '<span class="last-pos-pulse"></span>',
      iconSize: [14, 14],
    }),
    keyboard: false,
    interactive: false,
  }).addTo(map);

  const fitted = L.latLngBounds(latlngs).pad(FIT_PAD);
  map.fitBounds(fitted);
  coverBoxWithWorld(map, el, fitted);

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
      `<span>${fmtInt(altLo)} m</span>` +
      '<span class="map-legend-bar"></span>' +
      `<span>${fmtInt(altHi)} m</span>`;
    return div;
  };
  legend.addTo(map);
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
