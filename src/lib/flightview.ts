/** Client-side map rendering for the live view. */

import type L from "leaflet";
import { renderMap, type MapOptions } from "./map";
import type { FlightMeta, TrackPoint } from "./types";

/** Returns the Leaflet map, or null when there was nothing to draw. Callers
 * that re-render must call remove() on it first; see renderMap. */
export function renderMapInto(
  el: HTMLElement, meta: FlightMeta, track: TrackPoint[],
  opts: MapOptions = {},
): L.Map | null {
  if (!track.length && !opts.ghosts?.length && !opts.overlays?.length
    && meta.launch_lat == null) return null;
  el.classList.add(opts.sizing === "fill" ? "fv-map-fill" : "fv-map");
  return renderMap(el, meta, track, opts);
}
