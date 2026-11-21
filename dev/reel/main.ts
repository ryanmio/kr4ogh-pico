/** The page dev/reel.mjs serves: one flight's reel (src/lib/reel/scene.ts),
 * filling a 9:16 stage. Open in a browser it plays; the renderer drives it
 * a frame at a time through window.reel.
 *
 * The flight comes from /reel-data.json, which reel.mjs answers from
 * flights.toml and the committed tracks the way the site's build reads
 * them. A live flight is then brought up to the minute from wspr.live,
 * the same refresh the site's own pages run.
 *
 *   ?flight=PT02   which flight; the site's featured one without
 *   &hours=24      only the first hours of it
 *   &seconds=15    length of the film
 *   &units=metric  or imperial
 *   &live=0        the committed track as it is, no refresh
 *   &cta=...       a closing line
 *   &lights=0      no town lights on the night side
 */
import { refreshTrack } from "../../src/lib/livetrack";
import { createReel, type Reel } from "../../src/lib/reel/scene";
import type { FlightMeta, GhostPoint, TrackPoint } from "../../src/lib/types";
import { isUnits } from "../../src/lib/units";

declare global {
  interface Window { reel?: Reel; reelReady?: Promise<Reel>; reelInfo?: Record<string, unknown> }
}

interface Data {
  meta: FlightMeta; track: TrackPoint[]; ghosts: GhostPoint[]; spoofed: TrackPoint[];
}

const params = new URLSearchParams(location.search);

window.reelReady = (async () => {
  const res = await fetch(`/reel-data.json?flight=${encodeURIComponent(params.get("flight") ?? "")}`);
  if (!res.ok) throw new Error(await res.text());
  let { meta, track, ghosts, spoofed } = await res.json() as Data;
  let refreshed = "committed track";
  if (meta.status === "live" && params.get("live") !== "0") {
    const r = await refreshTrack(meta, track, ghosts, spoofed);
    refreshed = r.error ? `committed track (wspr.live: ${r.error.message})` : `wspr.live, ${r.added} new`;
    ({ track, ghosts, spoofed } = r);
  }
  const units = params.get("units");
  const hours = Number(params.get("hours")) || undefined;
  const reel = await createReel({
    container: document.getElementById("stage")!,
    meta, track, ghosts, spoofed,
    units: isUnits(units) ? units : "imperial",
    seconds: Number(params.get("seconds")) || 15,
    hours,
    cta: params.get("cta") ?? undefined,
    // reel.mjs keeps a copy of the night picture and serves it here.
    lightsUrl: params.get("lights") === "0" ? null : "/reel-lights.jpg",
  });
  window.reel = reel;
  window.reelInfo = {
    flight: `${meta.callsign} ${meta.flight_id}`, fixes: track.length,
    last: track.at(-1)?.utc, source: refreshed, lights: reel.lights,
  };
  if (params.get("play") !== "0") reel.play();
  return reel;
})();
