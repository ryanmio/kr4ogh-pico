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

export function renderMap(
  el: HTMLElement, meta: FlightMeta, track: TrackPoint[],
): void {
  const map = L.map(el, {
    preferCanvas: true,
    worldCopyJump: false,
    zoomControl: true,
    attributionControl: true,
  });
  L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 12 }).addTo(map);

  const lons = unwrapLons(track);
  const latlngs = track.map((p, i) => L.latLng(p.lat, lons[i]!));

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

  map.fitBounds(L.latLngBounds(latlngs).pad(0.15));
}
