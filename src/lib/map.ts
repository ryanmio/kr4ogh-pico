/** Leaflet track map. Points are colored by a selectable metric (altitude by
 * default); longitudes are unwrapped so a Pacific crossing draws as one
 * continuous line instead of jumping across the antimeridian. */

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  fitRegion, LABEL_URL, TILE_ATTRIBUTION, TILE_URL, unwrapLons,
} from "./basemap";
import { fmtUtc } from "./format";
import { lastKnown, trailingGhosts, unwrapGhostLons } from "./ghosts";
import { METRICS, rampColor, rampGradient, type MetricKey } from "./metrics";
import { speedText } from "./speed";
import { altitude as fmtAltitude, type Units } from "./units";
import type { FlightMeta, GhostPoint, TrackPoint } from "./types";

export interface MapOptions {
  units?: Units;
  /** Slots heard without telemetry, drawn as ghosts beside the track. */
  ghosts?: GhostPoint[];
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
  const ghosts = opts.ghosts ?? [];

  const lons = unwrapLons(track);
  const latlngs = track.map((p, i) => L.latLng(p.lat, lons[i]!));
  const ghostLons = unwrapGhostLons(track, lons, ghosts);
  const ghostLatlngs = ghosts.map((g, i) => L.latLng(g.lat, ghostLons[i]!));
  // Ghosts newer than the last fix: the balloon has been heard along them
  // since it last sent telemetry, so they are the end of the story, drawn
  // as a dashed tail with the beacon on the last of them.
  const tail = trailingGhosts(track, ghosts);
  const tailLatlngs = ghostLatlngs.slice(ghosts.length - tail.length);
  const here = lastKnown(track, ghosts);
  const hereLatlng = tail.length ? tailLatlngs.at(-1)! : latlngs.at(-1);
  // The fit takes every position, with the balloon last (fitRegion's
  // contract): a ghost off the side of the track must not sit off screen.
  const fitPts = hereLatlng
    ? [...latlngs, ...ghostLatlngs].filter((ll) => ll !== hereLatlng).concat(hereLatlng)
    : [];
  // Worked out before the map exists, because on "fit" pages the box has to
  // be the right height before Leaflet measures it.
  const fitted = fitPts.length > 0 ? fitBoundsFor(fitPts) : null;
  if (fitted && !fill) fitHeightToBounds(el, fitted);

  const map = L.map(el, {
    preferCanvas: true,
    // Replaced below by a continuous handler; see smoothWheelZoom.
    scrollWheelZoom: false,
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
  smoothWheelZoom(map);
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
      radius: 8, color: "#e2e8f0", weight: 2, fillColor: "#0b1020",
      fillOpacity: 1,
    }).bindTooltip(`Launch${meta.launch_utc ? " · " + fmtUtc(meta.launch_utc) : ""}`)
      .addTo(map);
  }

  if (!hereLatlng || !here) {
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
  L.polyline(latlngs, { color: "#0b1020", weight: 7, opacity: 0.5 }).addTo(map);
  L.polyline(latlngs, { color: "#e2e8f0", weight: 2.6, opacity: 0.9 }).addTo(map);
  // The tail is dashed and never joins the line: a grid square is a claim
  // of where the balloon was to within 80 km, and the solid line is a claim
  // of 4. From the last fix out to the newest ghost, or ghost to ghost when
  // no fix has been decoded at all yet.
  if (tail.length) {
    const tailLine = [...(latlngs.length ? [latlngs.at(-1)!] : []), ...tailLatlngs];
    L.polyline(tailLine, { color: "#0b1020", weight: 6, opacity: 0.4 }).addTo(map);
    L.polyline(tailLine, {
      color: "#e2e8f0", weight: 2, opacity: 0.8, dashArray: "4 7",
    }).addTo(map);
  }
  // The square the balloon is somewhere in, when a ghost is the newest
  // report: the beacon alone would claim a precision the report lacks.
  if (here.coarse) {
    L.rectangle(
      L.latLngBounds(
        L.latLng(hereLatlng.lat - 0.5, hereLatlng.lng - 1),
        L.latLng(hereLatlng.lat + 0.5, hereLatlng.lng + 1),
      ),
      { color: "#e2e8f0", weight: 1, opacity: 0.5, dashArray: "3 5", fill: false,
        interactive: false },
    ).addTo(map);
  }

  // The polylines above carry the full track; the per-point spots are drawn
  // separately, and redrawn at each zoom -- see drawSpots.
  const raws = track.map((p) => metric.raw(p));
  const lo = raws.length ? Math.min(...raws) : 0;
  const hi = raws.length ? Math.max(...raws) : 0;
  const spots = L.layerGroup().addTo(map);

  /** Draw the spots for the current zoom, dropping any that would land on
   * top of one already drawn.
   *
   * Zoomed out, a week of ten-minute fixes falls inside a few pixels. Drawing
   * them all stacks each dot's translucent casing over its neighbours' fill,
   * and forty of those compound into a dark colourless mass -- the colour is
   * still there, buried under the outlines. Spacing them by their own width
   * keeps every dot's fill visible, and none of the detail is lost: the line
   * underneath still carries the whole path, and zooming in brings the rest
   * of the spots back as fast as there is room for them.
   *
   * The spots shrink as they thin, so the world view is a line with beads on
   * it rather than a widely spaced string of discs.
   *
   * The launch and the newest fix are always drawn. They are the two ends of
   * the story, and the newest one has the pulse ring around it.
   *
   * `step` is the one thing that still drops a fix, and only past a few
   * thousand of them: a lap of the globe is months of ten-minute reports and
   * the canvas has to redraw every one of them on every pan. Below that
   * ceiling -- which is every flight so far -- every fix is on the map. */
  const step = Math.max(1, Math.ceil(track.length / SPOT_CEILING));
  const drawSpots = () => {
    spots.clearLayers();
    // The two ends keep their full size at every zoom: they are the launch
    // and the balloon, and the pulse ring is drawn around the second one.
    const radius = spotRadiusFor(map.getZoom());
    const shown = track.filter((_, i) =>
      i === 0 || i === track.length - 1 || i % step === 0);
    const sizeOf = (p: TrackPoint) =>
      p === shown[0] || p === shown[shown.length - 1] ? SPOT_RADIUS : radius;

    // Ghosts go under everything: hollow, dim, a little smaller than a
    // spot, and never thinned -- there are only ever a handful. The one
    // the beacon sits on keeps a spot's full size, the way the two ends
    // of the track do.
    ghosts.forEach((g, i) => {
      const isHere = here.coarse && i === ghosts.length - 1;
      L.circleMarker(ghostLatlngs[i]!, {
        radius: isHere ? SPOT_RADIUS : Math.max(GHOST_MIN_RADIUS, radius - 1.5),
        color: GHOST_STROKE, weight: 1.2, opacity: 0.8,
        fillColor: SPOT_OUTLINE, fillOpacity: 0.45,
      }).bindTooltip(
        `${fmtUtc(g.utc)}<br>heard in ${g.grid4} by ` +
        `${g.rx_station_count} station${g.rx_station_count === 1 ? "" : "s"}` +
        " · no telemetry",
      ).addTo(spots);
    });

    // Outlines first, all of them, then the fills. Drawn per spot instead,
    // each outline lands on its neighbours' fill wherever fixes overlap, and
    // forty of them compound into the dark colourless mass that made a slow
    // stretch of the flight unreadable. In two passes the outlines merge
    // into one silhouette around the run and the fills cover the inside of
    // it, so an outline is only ever seen where there is something to
    // outline: around the group, and around a spot standing on its own.
    for (const p of shown) {
      L.circleMarker([p.lat, p.lon], {
        radius: sizeOf(p) + SPOT_OUTLINE_PX,
        stroke: false,
        fillColor: SPOT_OUTLINE,
        fillOpacity: 1,
        interactive: false,
      }).addTo(spots);
    }
    for (const p of shown) {
      const raw = metric.raw(p);
      L.circleMarker([p.lat, p.lon], {
        radius: sizeOf(p),
        stroke: false,
        fillColor: rampColor(metric.ramp, hi > lo ? (raw - lo) / (hi - lo) : 0.5),
        fillOpacity: 1,
      }).bindTooltip(
        `${fmtUtc(p.utc)}<br>${fmtAltitude(p.altitude_m, units).text}` +
        ` · ${speedText(p, units)} · ${p.voltage_v.toFixed(2)} V`,
      ).addTo(spots);
    }
  };

  // The most recent position gets a pulsing ring (a DOM icon, since the
  // canvas renderer cannot animate). It is hollow on purpose: the
  // metric-coloured dot for this same fix is underneath and has to stay
  // readable, or the newest point is the one point whose value you cannot
  // see.
  L.marker(hereLatlng, {
    icon: L.divIcon({
      className: "last-pos-icon",
      html: '<span class="last-pos-pulse"></span>',
      iconSize: [22, 22],
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
  // Now that the map is at its fitted zoom, the spots know how far apart
  // they land on screen. Every zoom after this one re-thins them.
  drawSpots();
  map.on("zoomend", drawSpots);
  const allLons = [...lons, ...ghostLons];
  map.setMaxBounds(L.latLngBounds(
    L.latLng(-85, Math.min(...allLons) - 360),
    L.latLng(85, Math.max(...allLons) + 360),
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

/** Radius of a spot close in, and at the world view, where a run of fixes
 * merges into a band and a slightly smaller dot keeps the track reading as a
 * track. Every fix is drawn at every zoom either way: a spot is a report
 * that exists, and dropping one to tidy the picture is a lie about the
 * flight. */
const SPOT_RADIUS = 6;
const SPOT_MIN_RADIUS = 4;

/** Zooms the radius is interpolated between. Below the first is the whole
 * world in the box; above the second, a fix is a place you could point at. */
const SPOT_FULL_ZOOM = 7;
const SPOT_SMALL_ZOOM = 2;

/** Width of a spot's outline, and its colour. Opaque, because the outlines
 * are drawn as a pass of their own and overlap each other. */
const SPOT_OUTLINE_PX = 1.5;
const SPOT_OUTLINE = "#0b1020";

/** A ghost's ring, and the smallest it shrinks to at the world view. The
 * ring is the track's own light grey: a ghost is a report of the balloon,
 * not a value on the metric ramp, so it takes no colour from it. */
const GHOST_STROKE = "#e2e8f0";
const GHOST_MIN_RADIUS = 2.5;

/** How many spots the canvas will carry before they start being sampled.
 * Each one is two circles, an outline and a fill. */
const SPOT_CEILING = 2000;

function spotRadiusFor(zoom: number): number {
  const t = Math.max(0, Math.min(1,
    (zoom - SPOT_SMALL_ZOOM) / (SPOT_FULL_ZOOM - SPOT_SMALL_ZOOM)));
  return SPOT_MIN_RADIUS + t * (SPOT_RADIUS - SPOT_MIN_RADIUS);
}

/** How far a wheel has to travel for one zoom level, in pixels. macOS piles
 * acceleration onto a trackpad swipe, so a brisk one is several hundred
 * pixels of delta and this is what keeps that worth a couple of levels
 * rather than a dozen. */
const WHEEL_PX_PER_LEVEL = 200;

/** Pinching a trackpad arrives as ctrl+wheel. It is a deliberate zoom rather
 * than a scroll that happens to be over the map, so it moves further. */
const PINCH_GAIN = 2;

/** How long after the last wheel event the map settles and loads its tiles. */
const WHEEL_SETTLE_MS = 120;

/** The two Leaflet internals the smooth path needs. Neither is public, and
 * neither has a public equivalent: `setView` is the only exposed way to
 * change zoom and it resets the view every call. These are the same pair
 * Leaflet's own touch pinch handler uses, so they move with that code rather
 * than being a private corner of it. */
interface ZoomInternals {
  _move(
    center: L.LatLng, zoom: number,
    data?: { pinch?: boolean; round?: boolean },
  ): void;
  _resetView(center: L.LatLng, zoom: number): void;
}

/** Continuous wheel zoom, in place of Leaflet's own.
 *
 * Leaflet buffers 40 ms of wheel events, runs the total through a sigmoid and
 * applies it in one jump. That is right for a notched mouse wheel and wrong
 * for a trackpad, which sends a stream of small deltas: a two-finger swipe
 * came to about one zoom level, delivered in visible stair-steps.
 *
 * The zoom itself goes through `_move` with `pinch`, which is the same path
 * Leaflet's own touch pinch uses: tile layers respond by transforming what is
 * already on screen instead of reloading. Zooming with `setView` per frame
 * instead re-runs the whole view reset every frame, and each one aborts the
 * tile requests the last one started, so nothing ever finishes loading and
 * the map goes black under the gesture. The settle at the end is the single
 * reset that does load tiles, once, at the zoom the reader stopped on.
 */
function smoothWheelZoom(map: L.Map): void {
  const inner = map as L.Map & ZoomInternals;
  const el = map.getContainer();
  let pending = 0;
  let anchor: L.Point | null = null;
  let frame = 0;
  let settle = 0;
  let moving = false;
  let startZoom = 0;

  const apply = () => {
    frame = 0;
    const delta = pending;
    pending = 0;
    if (!delta || !anchor) return;
    const from = map.getZoom();
    const to = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), from + delta));
    if (to === from) return;
    // Hold the point under the pointer still, the way setZoomAround does.
    const scale = map.getZoomScale(to, from);
    const half = map.getSize().divideBy(2);
    const offset = anchor.subtract(half).multiplyBy(1 - 1 / scale);
    const center = map.containerPointToLatLng(half.add(offset));
    if (!moving) {
      moving = true;
      startZoom = from;
      map.fire("zoomstart");
    }
    inner._move(center, to, { pinch: true, round: false });
  };

  const onWheel = (ev: WheelEvent) => {
    // The page must not scroll behind a map that is handling the gesture.
    ev.preventDefault();
    // Firefox reports lines and pages as well as pixels.
    const px = ev.deltaMode === 1 ? ev.deltaY * 20
      : ev.deltaMode === 2 ? ev.deltaY * 60
        : ev.deltaY;
    // Clamped per event so one flick of a notched wheel cannot leap the
    // width of the flight.
    const step = Math.max(-1, Math.min(1, -px / WHEEL_PX_PER_LEVEL));
    pending += ev.ctrlKey ? step * PINCH_GAIN : step;
    anchor = map.mouseEventToContainerPoint(ev);
    if (!frame) frame = requestAnimationFrame(apply);
    clearTimeout(settle);
    settle = window.setTimeout(() => {
      if (!moving) return;
      moving = false;
      inner._resetView(map.getCenter(), map.getZoom());
      // _resetView compares the zoom it is given against the map's own, and
      // the gesture has already moved that, so it sees no change and stays
      // quiet. Anything waiting on zoomend -- the spot thinning, for one --
      // would never hear that the zoom had finished changing.
      if (map.getZoom() !== startZoom) map.fire("zoomend");
    }, WHEEL_SETTLE_MS);
  };

  el.addEventListener("wheel", onWheel, { passive: false });
  // The live view rebuilds its map on every refresh, into the same element:
  // `map.remove()` disposes the map but leaves the container standing. A
  // listener left on it would outlive its map, and the next scroll would
  // reach into a torn-down one.
  map.on("unload", () => {
    el.removeEventListener("wheel", onWheel);
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(settle);
  });
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
