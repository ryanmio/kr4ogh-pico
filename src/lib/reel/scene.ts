/** The reel: a flight replayed from just behind the balloon.
 *
 * A short vertical film of one flight, for sharing. The camera rides
 * behind and above the balloon and looks past it to the horizon, the
 * planet turning underneath at the speed the balloon actually made, and at
 * the end it pulls back until the whole path is in the frame. Everything
 * on screen is the flight's own data: the line is the one the map draws
 * (flightpath.ts), the light is where the sun was (sky.ts), and each thin
 * post under the line is a report that was heard, so a night the tracker
 * slept through is a stretch with none. Beside the balloon is the name of
 * what it is over (places.ts).
 *
 * Height is drawn far taller than it is. A balloon at 12 km over a path
 * thousands of kilometres long is, to scale, on the ground; the reel draws
 * its height many times over, by however much makes the climb and the
 * float read at the speed the film plays. The numbers on screen are the
 * real ones.
 *
 * `seek` puts the film at an instant and resolves once that frame is
 * fully drawn, tiles and all, which is what lets dev/reel.mjs render it
 * frame by frame; `play` runs it against the clock for watching.
 */
import { Map as MapGL, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { TILE_URL } from "../basemap";
import { parseUtc } from "../format";
import type { FlightMeta, GhostPoint, TrackPoint } from "../types";
import * as u from "../units";
import type { Units } from "../units";
import { drawBalloon, fillAt, WIRE_END } from "./balloon";
import {
  add, buildPath, cross, dot, EARTH_KM, len, lonLat, norm, rotate, scale, slerp, sub,
  sunVector, type FlightPath, type Vec3,
} from "./flightpath";
import placesUrl from "../../data/places.json?url";
import { overLine, placeFinder, type PlaceData } from "./places";
import { skyLayer, toGlobe, type Camera } from "./sky";
import { CREDIT, LIGHTS_URL, MARBLE_URL } from "./sources";

setWorkerUrl(workerUrl);

export interface ReelOptions {
  container: HTMLElement;
  meta: FlightMeta;
  track: TrackPoint[];
  ghosts: GhostPoint[];
  spoofed?: { utc: string }[];
  units: Units;
  /** Length of the film, in seconds. */
  seconds: number;
  /** Only this many hours from the first fix; the whole flight without. */
  hours?: number;
  /** A last line under the closing figure, such as where to follow it. */
  cta?: string;
  /** Where to get the picture of the Earth at night from, for a copy
   * kept nearer than NASA's (sources.ts); null for a reel with no town
   * lights. */
  lightsUrl?: string | null;
}

export interface Reel {
  seconds: number;
  /** Whether the towns are lit: false when the picture of the Earth at
   * night was not asked for or could not be had. */
  lights: boolean;
  /** Draw the frame at `t` seconds and resolve when it is complete. */
  seek(t: number): Promise<void>;
  play(): void;
  stop(): void;
  destroy(): void;
}

const RAD = Math.PI / 180;
/** Vertical field of view. Wider than MapLibre's default: the horizon
 * curves more and the ground comes past faster. */
const FOV_DEG = 40;
/** The pull-back at the end, in seconds, and how long the clock takes to
 * coast to a stop before it. */
const REVEAL_S = 3.4;
const COAST_S = 0.9;
/** Where things sit in the frame during the chase, as fractions of its
 * height from the top: the horizon, the balloon, and the point on the
 * ground under it. The camera is solved to put them there. */
const AT_HORIZON = 0.285;
const AT_BALLOON = 0.535;
const AT_GROUND = 0.80;

/** The map zoom the site's own imagery comes in over the Blue Marble at
 * (sources.ts). */
const DETAIL_FROM_ZOOM = 6.9;

const smooth = (a: number, b: number, x: number) => {
  const f = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return f * f * (3 - 2 * f);
};
const mix = (a: number, b: number, f: number) => a + (b - a) * f;

/** Angle below the lens axis at a height in the frame. */
function below(frac: number): number {
  return Math.atan((frac - 0.5) * 2 * Math.tan(FOV_DEG * RAD / 2));
}

/** How far along the ground, as an angle at the Earth's centre, a ray
 * leaving an eye at radius r (in Earth radii) at `depression` below level
 * lands. */
function groundReach(r: number, depression: number): number {
  const eta = Math.PI / 2 - depression;
  return Math.asin(Math.min(1, r * Math.sin(eta))) - eta;
}

/** The chase camera for a balloon drawn `heightKm` up: how high the eye
 * is, how far behind, and how far below level it looks, so that horizon,
 * balloon and ground point land at AT_HORIZON, AT_BALLOON and AT_GROUND. */
function chaseFrame(heightKm: number): { eyeKm: number; back: number; tilt: number } {
  const solve = (eyeKm: number) => {
    const r = 1 + eyeKm / EARTH_KM;
    const tilt = Math.acos(1 / r) - below(AT_HORIZON);
    const back = groundReach(r, tilt + below(AT_GROUND));
    const d = tilt + below(AT_BALLOON);
    const rho = r / (Math.tan(d) * Math.sin(back) + Math.cos(back));
    return { tilt, back, drawnKm: (rho - 1) * EARTH_KM };
  };
  let lo = 0.5;
  let hi = 4 * EARTH_KM;
  for (let i = 0; i < 60; i++) {
    const mid = Math.sqrt(lo * hi);
    if (solve(mid).drawnKm < heightKm) lo = mid; else hi = mid;
  }
  const s = solve(hi);
  return { eyeKm: hi, back: s.back, tilt: s.tilt };
}

/** Where the eye is and what it looks at: both as unit vectors on the
 * ground, the eye with a height in km above its own. */
interface Pose { eye: Vec3; eyeKm: number; look: Vec3 }

/** A pose as MapLibre takes a camera: the point at the centre of the
 * screen, and the eye's distance from it as a zoom, with pitch and bearing
 * measured where the centre is, not where the eye is. On a sphere those
 * are different places with different ideas of north and of down, which
 * is why this does not go through
 * calculateCameraOptionsFromCameraLngLatAltRotation: that takes the angles
 * at the eye, and several degrees out of place is the horizon in the
 * wrong third of the frame. `heightPx` is the frame's height. */
function aim(p: Pose, heightPx: number): {
  center: [number, number]; zoom: number; bearing: number; pitch: number;
} {
  const e = scale(p.eye, 1 + p.eyeKm / EARTH_KM);
  const v = sub(e, p.look);
  const dist = len(v);
  const east = norm(cross([0, 0, 1], p.look));
  const north = cross(p.look, east);
  const [lng, lat] = lonLat(p.look);
  // The globe's radius on screen is the world's width over 2 pi, over
  // the cosine of the centre's latitude; the eye sits where the frame's
  // height subtends the field of view.
  const eyePx = 0.5 * heightPx / Math.tan(FOV_DEG * RAD / 2);
  const zoom = Math.log2(eyePx * 2 * Math.PI * Math.cos(lat * RAD) / (512 * dist));
  return {
    center: [lng, lat],
    zoom,
    bearing: Math.atan2(-dot(v, east), -dot(v, north)) / RAD,
    pitch: Math.acos(Math.min(1, Math.max(-1, dot(v, p.look) / dist))) / RAD,
  };
}

/** Move a point on the ground `angle` radians along a direction tangent
 * to the ground there. */
function travel(p: Vec3, dir: Vec3, angle: number): Vec3 {
  return norm(add(scale(p, Math.cos(angle)), scale(dir, Math.sin(angle))));
}

/** A step for a number on screen, so that it changes no more than
 * `perSecond` times a second at the rate it is moving. */
function stepFor(ratePerSecond: number, perSecond: number, steps: number[]): number {
  return steps.find((s) => ratePerSecond / s <= perSecond) ?? steps.at(-1)!;
}

const CSS = `
.reel { position: relative; overflow: hidden; background: #03060d; color: #e8eefb;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --accent: #7dd3fc; --live: #34d399; }
.reel-map, .reel-draw, .reel-hud { position: absolute; inset: 0; width: 100%; height: 100%; }
.reel-draw, .reel-hud { pointer-events: none; }
.reel-hud { font-size: calc(var(--w) / 100); }
.reel-shade { position: absolute; left: 0; right: 0; top: 0; height: 31%;
  background: linear-gradient(180deg, rgba(3,6,13,0.3) 0%, rgba(3,6,13,0.22) 70%, rgba(3,6,13,0) 100%); }
.reel-top { position: absolute; left: 6.5em; right: 6.5em; top: 23.5em; }
.reel-id { display: flex; align-items: baseline; justify-content: space-between; }
.reel-call { font-family: var(--mono); font-weight: 700; font-size: 5.6em; letter-spacing: 0.08em; }
.reel-call span { color: var(--accent); }
.reel-status { font-family: var(--mono); font-weight: 600; font-size: 2.35em; letter-spacing: 0.12em;
  display: flex; align-items: center; gap: 0.55em; color: #b9c6e6; }
.reel-status i { width: 0.62em; height: 0.62em; border-radius: 50%; background: var(--live);
  box-shadow: 0 0 0.7em var(--live); }
.reel-status.asleep i { background: #8d9ac0; box-shadow: none; }
.reel-sub { margin-top: 0.5em; font-family: var(--mono); font-size: 2.3em; letter-spacing: 0.16em;
  color: #9fb0d6; text-transform: uppercase; }
.reel-stats { margin-top: 2.6em; display: grid; grid-template-columns: 0.72fr 1.1fr 0.9fr 1.05fr;
  gap: 0 1.6em; border-top: 0.12em solid rgba(159,176,214,0.32); padding-top: 1.5em; }
.reel-stat label { display: block; font-family: var(--mono); font-size: 1.95em; letter-spacing: 0.16em;
  color: #9fb0d6; }
.reel-stat b { display: block; margin-top: 0.12em; font-size: 5.2em; font-weight: 650;
  font-variant-numeric: tabular-nums; letter-spacing: -0.01em; line-height: 1.12; white-space: nowrap; }
.reel-stat b small { font-size: 0.46em; font-weight: 500; color: #9fb0d6; margin-left: 0.28em;
  letter-spacing: 0.02em; }
.reel-stat.quiet b { color: #7f8cb0; }
.reel-end { position: absolute; left: 6.5em; right: 6.5em; top: 125em; text-align: center; }
.reel-end b { display: block; font-size: 11.5em; font-weight: 700; letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums; line-height: 1; text-shadow: 0 0.04em 0.5em rgba(3,6,13,0.8); }
.reel-end b small { font-size: 0.42em; font-weight: 600; color: var(--accent); margin-left: 0.3em; }
.reel-end span { display: block; margin-top: 0.9em; font-family: var(--mono); font-size: 2.7em;
  letter-spacing: 0.14em; color: #cfd9f2; text-transform: uppercase;
  text-shadow: 0 0.04em 0.6em rgba(3,6,13,0.9); }
.reel-end span:empty, .reel-end em:empty { display: none; }
.reel-end span + span { margin-top: 0.55em; color: var(--accent); }
.reel-end em { display: block; margin-top: 1.1em; font-style: normal; font-family: var(--mono);
  font-size: 2.5em; letter-spacing: 0.08em; color: var(--accent);
  text-shadow: 0 0.04em 0.6em rgba(3,6,13,0.9); }
.reel-over { position: absolute; top: 67.2%; width: 37em; padding: 0.3em 1.5em;
  text-shadow: 0 0 0.5em rgba(3,6,13,0.95), 0 0.05em 0.25em rgba(3,6,13,0.9); }
.reel-over.left { right: 55.5%; text-align: right; border-right: 0.22em solid var(--accent); }
.reel-over.right { left: 55.5%; text-align: left; border-left: 0.22em solid var(--accent); }
.reel-over label { display: block; font-family: var(--mono); font-size: 1.9em; letter-spacing: 0.2em;
  color: var(--accent); }
.reel-over b { display: block; margin-top: 0.08em; font-size: 4.3em; font-weight: 650;
  line-height: 1.08; letter-spacing: -0.01em; text-wrap: balance; }
.reel-over span { display: block; margin-top: 0.3em; font-family: var(--mono); font-size: 2.1em;
  letter-spacing: 0.12em; color: #cfd9f2; text-transform: uppercase; }
.reel-credit { position: absolute; left: 0; right: 0; bottom: 1.6em; text-align: center;
  font-size: 1.45em; color: rgba(207,217,242,0.5); letter-spacing: 0.04em; }
`;

export async function createReel(opts: ReelOptions): Promise<Reel> {
  const { container, meta, units } = opts;
  const first = parseUtc(opts.track[0]!.utc).getTime();
  const path: FlightPath = buildPath(opts.track, opts.ghosts, opts.spoofed ?? [], {
    toMs: opts.hours ? first + opts.hours * 3600000 : undefined,
  });
  const seconds = opts.seconds;
  const chaseS = seconds - REVEAL_S;
  const spanMs = path.endMs - path.startMs;
  const hoursPerSecond = spanMs / 3600000 / chaseS;

  // How much taller than life the height is drawn. The balloon covers
  // `reach` km of ground each second of film; drawn about four tenths of
  // that high, it sits well clear of the ground and the ground still
  // comes past at a speed that reads as flying.
  const reachKm = Math.max(25, path.cruiseKt * 1.852 * hoursPerSecond);
  const peakKm = path.peakAltitudeM / 1000;
  const drawnPeakKm = Math.min(900, Math.max(peakKm * 1.5, 0.42 * reachKm));
  const tall = drawnPeakKm / peakKm;
  const groundM = opts.track[0]!.altitude_m;
  const floatM = Math.max(meta.float_m ?? 0, path.peakAltitudeM);

  // ---- the page ----
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  container.classList.add("reel");
  container.innerHTML = `
    <div class="reel-map"></div>
    <canvas class="reel-draw"></canvas>
    <div class="reel-hud">
      <div class="reel-shade"></div>
      <div class="reel-top">
        <div class="reel-id">
          <div class="reel-call"></div>
          <div class="reel-status"><i></i><span></span></div>
        </div>
        <div class="reel-sub"></div>
        <div class="reel-stats">
          <div class="reel-stat" data-k="clock"><label></label><b></b></div>
          <div class="reel-stat" data-k="altitude"><label>ALTITUDE</label><b></b></div>
          <div class="reel-stat" data-k="speed"><label>SPEED</label><b></b></div>
          <div class="reel-stat" data-k="distance"><label>DISTANCE</label><b></b></div>
        </div>
      </div>
      <div class="reel-over"><label>OVER</label><b></b><span></span></div>
      <div class="reel-end"><b></b><span></span><span></span><em></em></div>
      <div class="reel-credit"></div>
    </div>`;
  const q = <T extends HTMLElement>(sel: string) => container.querySelector<T>(sel)!;
  const mapEl = q<HTMLDivElement>(".reel-map");
  const canvas = q<HTMLCanvasElement>(".reel-draw");
  const hud = q<HTMLDivElement>(".reel-hud");
  const ctx = canvas.getContext("2d")!;
  let W = 0;
  let H = 0;
  let dpr = 1;
  const resize = () => {
    W = container.clientWidth;
    H = container.clientHeight;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    hud.style.setProperty("--w", `${W}px`);
  };
  resize();

  const launched = parseUtc(meta.launch_utc ?? opts.track[0]!.utc);
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
  q(".reel-call").innerHTML = `${esc(meta.callsign)}<span> · ${esc(meta.flight_id)}</span>`;
  q(".reel-sub").textContent = "Pico balloon · launched " + launched.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
  q(".reel-credit").textContent = CREDIT;

  // ---- the globe ----
  // MapLibre picks a tile's zoom by its size in CSS pixels, so on a dense
  // screen, and in the renderer, it would stretch each over twice as many
  // real ones. Calling the tiles half their size has it fetch a level
  // deeper. The far-off picture goes a level deeper again: it is what
  // the closing view is made of, held on screen, from where MapLibre is
  // at its most sparing.
  const tileSize = dpr >= 1.5 ? 128 : 256;
  const map = new MapGL({
    container: mapEl,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    minZoom: -2,
    maxPitch: 100,
    renderWorldCopies: false,
    canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true },
    style: {
      version: 8,
      // Always a sphere: the default globe flattens into Mercator close
      // in, and the reel is close in.
      projection: { type: "vertical-perspective" },
      sources: {
        marble: { type: "raster", tiles: [MARBLE_URL], tileSize: tileSize / 2, maxzoom: 8 },
        basemap: { type: "raster", tiles: [TILE_URL], tileSize, maxzoom: 12 },
      },
      layers: [
        { id: "space", type: "background", paint: { "background-color": "#03060d" } },
        { id: "marble", type: "raster", source: "marble", paint: {
          "raster-fade-duration": 0, "raster-saturation": 0.1, "raster-contrast": 0.1,
          "raster-brightness-max": 0.94,
        } },
        // The site's own imagery over it, close in only.
        { id: "basemap", type: "raster", source: "basemap", minzoom: DETAIL_FROM_ZOOM, paint: {
          "raster-fade-duration": 0, "raster-saturation": 0.1, "raster-contrast": 0.06,
          "raster-opacity": ["interpolate", ["linear"], ["zoom"],
            DETAIL_FROM_ZOOM, 0, DETAIL_FROM_ZOOM + 0.9, 1],
        } },
      ],
    },
  });
  map.setVerticalFieldOfView(FOV_DEG);
  // Without the night picture the dark side is only dark; `lights` on
  // the reel says which it was, for a caller that minds.
  const lightsUrl = opts.lightsUrl === undefined ? LIGHTS_URL : opts.lightsUrl;
  const lights = new Promise<HTMLImageElement | null>((resolve) => {
    if (!lightsUrl) return resolve(null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    setTimeout(() => resolve(null), 90000);
    img.src = lightsUrl;
  });
  const places = fetch(placesUrl).then((r) => r.json() as Promise<PlaceData>).then(placeFinder);
  await new Promise<void>((resolve) => { map.once("load", () => resolve()); });

  const nightPicture = await lights;
  // What the film is showing: set by `frame`, read by the two renderers.
  let now = 0;
  let camera: Camera | null = null;
  map.addLayer(skyLayer(
    () => ({
      sun: sunVector(flightMs(now)),
      airDepth: Math.max(0.0035, 0.28 * drawnPeakKm / EARTH_KM),
      time: now,
    }),
    (c) => { camera = c; draw(); },
    nightPicture,
  ));

  // ---- time ----
  /** The flight's clock at a second of film: steady through the chase,
   * coasting to a stop as the camera starts to pull away. */
  function flightFrac(t: number): number {
    const x = Math.min(1, Math.max(0, t / chaseS));
    const x1 = 1 - COAST_S / chaseS;
    const v = 1 / (x1 + (1 - x1) / 2);
    if (x <= x1) return v * x;
    const r = (x - x1) / (1 - x1);
    return v * x1 + v * (1 - x1) * (r - r * r / 2);
  }
  function flightMs(t: number): number {
    return path.startMs + spanMs * flightFrac(t);
  }

  // ---- the camera ----
  /** The way the camera faces: the balloon's heading with the corners
   * taken off, so a turn is a sweep and not a snap. */
  function cameraHeading(ms: number, at: Vec3): Vec3 {
    const reachMs = spanMs / chaseS * 0.5;
    let h: Vec3 = [0, 0, 0];
    for (let k = -4; k <= 4; k++) {
      const w = Math.exp(-(k * k) / 8);
      h = add(h, scale(path.at(ms + k * reachMs / 2).heading, w));
    }
    return norm(sub(h, scale(at, dot(at, h))));
  }

  /** Which side of the track the camera rides on: the one that looks
   * towards the sunrises. Dawn is when the tracker wakes, and from the
   * right side the sun comes up in the frame as it does; from the other
   * it comes up behind the lens. +1 looks left of the heading. */
  const side = (() => {
    let lean = 0;
    let before = 0;
    for (let i = 0; i <= 400; i++) {
      const ms = path.startMs + spanMs * i / 400;
      const s = path.at(ms);
      const sun = sunVector(ms);
      const height = dot(s.pos, sun);
      if (i > 0 && before < 0 && height >= 0) {
        const toSun = norm(sub(sun, scale(s.pos, height)));
        lean += dot(cross(cameraHeading(ms, s.pos), toSun), s.pos);
      }
      before = height;
    }
    return lean < 0 ? -1 : 1;
  })();

  // The name of what it is over goes on the side the trail is not.
  container.querySelector(".reel-over")!.classList.add(side > 0 ? "right" : "left");

  function chasePose(t: number): Pose {
    const ms = flightMs(t);
    const s = path.at(ms);
    const heading = cameraHeading(ms, s.pos);
    // Close in on the ground, backing off as the balloon climbs.
    const climbed = smooth(0, 1, s.altitudeM / path.peakAltitudeM);
    const f = chaseFrame(drawnPeakKm * mix(0.3, 1, climbed));
    // Off to one side and drifting round, so the height has parallax.
    const swing = side * mix(30, 14, smooth(0, seconds, t)) * RAD;
    const behind = rotate(scale(heading, -1), s.pos, swing);
    const eye = travel(s.pos, behind, f.back);
    // Looking over the balloon's ground point, at where the lens axis
    // lands beyond it.
    const r = 1 + f.eyeKm / EARTH_KM;
    const toBalloon = norm(sub(s.pos, scale(eye, dot(eye, s.pos))));
    const look = travel(eye, toBalloon, groundReach(r, f.tilt));
    return { eye, eyeKm: f.eyeKm, look };
  }

  /** The closing view: from high over the middle of the path, far enough
   * back that the whole of it is in the frame. North is up, the one way
   * round a coastline is recognised at a glance, and the eye stands off
   * to the south so the planet's edge curves across the top.
   *
   * The middle of a path that has gone most of the way round the world
   * is the pole, and that is the view it gets: the planet from above,
   * the path a ring around it, which is the one picture that shows a lap
   * as a lap. There the eye stands off towards the balloon instead, south
   * being every direction, so the balloon is on the near side. */
  const revealPose: Pose = (() => {
    const end = path.pos(path.count - 1);
    let sum: Vec3 = [0, 0, 0];
    for (let i = 0; i < path.count; i += 4) sum = add(sum, path.pos(i));
    // A path with no middle (once round the equator, say) is seen from
    // over the balloon.
    let centre = len(sum) / (path.count / 4) < 0.15 ? end : norm(sum);
    // Not the pole itself, though: MapLibre's centre stops at the edge of
    // Mercator, and well before that it draws the planet from coarser
    // tiles the nearer the pole the centre is. So the view looks at a
    // point short of it, on the balloon's side.
    const poleward = Math.asin(centre[2]) / RAD;
    const polar = smooth(50, 74, Math.abs(poleward));
    if (Math.abs(poleward) > 74) {
      const [lon] = lonLat(end);
      const lat = 74 * Math.sign(poleward) * RAD;
      centre = [Math.cos(lat) * Math.cos(lon * RAD), Math.cos(lat) * Math.sin(lon * RAD), Math.sin(lat)];
    }
    const tanV = Math.tan(FOV_DEG * RAD / 2);
    const tanH = tanV * W / H;
    const wholeGlobeKm = (1 / Math.sin(0.86 * Math.atan(tanH)) - 1) * EARTH_KM;
    const south = norm(sub(scale(centre, centre[2]), [0, 0, 1]));
    const toBalloon = sub(end, scale(centre, dot(centre, end)));
    const near = len(toBalloon) > 1e-6
      ? norm(add(scale(south, 1 - polar), scale(norm(toBalloon), polar))) : south;
    const poseAt = (km: number): Pose => (
      { eye: travel(centre, near, Math.min(0.5, 0.4 * km / EARTH_KM)), eyeKm: km, look: centre });
    const fits = (p: Pose): boolean => {
      const e = scale(p.eye, 1 + p.eyeKm / EARTH_KM);
      const fwd = norm(sub(p.look, e));
      const right = norm(cross(fwd, p.look));
      const up = cross(right, fwd);
      for (let i = 0; i < path.count; i += 2) {
        const at = scale(path.pos(i), 1 + path.alt(i) / 1000 * tall / EARTH_KM);
        const v = sub(at, e);
        const z = dot(v, fwd);
        if (z <= 0) return false;
        const x = 0.5 + 0.5 * dot(v, right) / (z * tanH);
        const y = 0.5 - 0.5 * dot(v, up) / (z * tanV);
        if (x < 0.09 || x > 0.91 || y < 0.34 || y > 0.615) return false;
      }
      return true;
    };
    for (let km = drawnPeakKm * 2; km < wholeGlobeKm * 1.6; km *= 1.04) {
      const p = poseAt(km);
      if (fits(p)) return p;
    }
    return poseAt(wholeGlobeKm);
  })();

  function poseAtTime(t: number): Pose {
    const chase = chasePose(t);
    const f = smooth(chaseS - COAST_S, seconds - 0.5, t);
    if (f <= 0) return chase;
    return {
      eye: slerp(chase.eye, revealPose.eye, f),
      eyeKm: chase.eyeKm * Math.pow(revealPose.eyeKm / chase.eyeKm, f),
      look: slerp(chase.look, revealPose.look, f),
    };
  }

  // ---- the numbers ----
  const stat = (k: string) => q<HTMLDivElement>(`.reel-stat[data-k="${k}"]`);
  const setStat = (k: string, value: string, unit: string, quiet = false) => {
    const el = stat(k);
    const html = `${value}<small>${unit}</small>`;
    const b = el.querySelector("b")!;
    if (b.innerHTML !== html) b.innerHTML = html;
    el.classList.toggle("quiet", quiet);
  };
  const days = spanMs / 86400000;
  const clockStepH = stepFor(hoursPerSecond, 2.5, [1, 2, 3, 6, 12, 24]);
  const total = u.distance(path.totalKm, units);
  const distStep = stepFor(total.value / chaseS, 5, [1, 5, 10, 25, 50, 100, 250, 500, 1000]);
  const altStep = units === "imperial" ? 500 : 100;
  stat("clock").querySelector("label")!.textContent = "ELAPSED";
  const statusEl = q<HTMLDivElement>(".reel-status");
  const endEl = q<HTMLDivElement>(".reel-end");
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

  // ---- where it is ----
  /** What the balloon is over, frame by frame through the chase, settled
   * so that no name is up for less than about two thirds of a second. */
  const OVER_HZ = 30;
  const find = await places;
  const overFrames = (() => {
    const frames = Math.round(chaseS * OVER_HZ) + 1;
    const named = [];
    for (let f = 0; f < frames; f++) {
      const [lon, lat] = lonLat(path.at(flightMs(f / OVER_HZ)).pos);
      named.push(find(lon, lat));
    }
    return overLine(named, Math.round(0.65 * OVER_HZ));
  })();
  const overEl = q<HTMLDivElement>(".reel-over");

  /** A number on screen is read at a held instant, a few times a second,
   * so it steps at a pace an eye can follow instead of blurring. */
  const held = (t: number, hz: number) => path.at(flightMs(Math.floor(t * hz) / hz));

  function drawHud(t: number): void {
    const done = t >= chaseS;
    const ms = flightMs(Math.floor(t * 4) / 4);
    const hours = (ms - path.startMs) / 3600000;
    const h = done ? spanMs / 3600000 : Math.floor(hours / clockStepH) * clockStepH;
    if (days > 3) {
      const d = Math.floor(h / 24);
      setStat("clock", `${d}`, clockStepH >= 24 || done ? "d" : `d ${Math.floor(h - d * 24)}h`);
    } else {
      setStat("clock", `${Math.floor(h)}`, "h");
    }
    const a = held(t, 4);
    const quiet = !a.heard;
    setStat("altitude", fmt(Math.round(u.altitude(a.altitudeM, units).value / altStep) * altStep),
      u.unitLabels(units).altitude, quiet);
    const sp = held(t, 3);
    setStat("speed", fmt(Math.round(u.speed(sp.speedKt, units).value / 5) * 5),
      u.unitLabels(units).speed, quiet);
    const d = held(t, 6);
    const dist = u.distance(d.distanceKm, units).value;
    setStat("distance", fmt(done ? total.value : Math.floor(dist / distStep) * distStep),
      u.unitLabels(units).distance);

    const sunlit = dot(a.pos, sunVector(ms)) > -0.05;
    // A flight that is over ends on that, not on its last report as if
    // it were still coming in.
    const over = done && meta.status === "closed" && !opts.hours;
    const label = over ? "FLIGHT ENDED"
      : a.heard ? "TRANSMITTING" : sunlit ? "NO SIGNAL" : "ASLEEP · NO SUN";
    const span = statusEl.querySelector("span")!;
    if (span.textContent !== label) span.textContent = label;
    statusEl.classList.toggle("asleep", over || !a.heard);

    const at = overFrames[Math.min(overFrames.length - 1, Math.floor(t * OVER_HZ))];
    const nameEl = overEl.querySelector("b")!;
    const withinEl = overEl.querySelector("span")!;
    if (at && nameEl.textContent !== at.name) nameEl.textContent = at.name;
    if (withinEl.textContent !== (at?.within ?? "")) withinEl.textContent = at?.within ?? "";
    // Each name comes up over a fifth of a second; the line leaves as the
    // camera does, when the planet itself says where the balloon is.
    const arrive = at ? smooth(0, 0.2, at.since / OVER_HZ) : 0;
    overEl.style.opacity = String(arrive * (1 - smooth(chaseS - COAST_S, chaseS, t)));
    overEl.style.transform = `translateY(${(1 - arrive) * 0.8}em)`;

    const show = smooth(chaseS + 0.5, chaseS + 1.5, t);
    endEl.style.opacity = String(show);
    endEl.style.transform = `translateY(${(1 - show) * 1.5}em)`;
  }
  {
    const live = meta.status === "live" && !opts.hours;
    const long = days >= 2 ? `${days.toFixed(days < 10 ? 1 : 0)} days` : `${Math.round(spanMs / 3600000)} hours`;
    endEl.querySelector("b")!.innerHTML = `${fmt(total.value)}<small>${total.unit === "mi" ? "miles" : "km"}</small>`;
    const lines = endEl.querySelectorAll("span");
    lines[0]!.textContent = (opts.hours ? `in its first ${long}` : `in ${long}`)
      + (live ? " · still flying" : "");
    // And where that leaves it, for the whole of a flight: exactly, since
    // this line is held and has no need of settling.
    const [lon, lat] = lonLat(path.pos(path.count - 1));
    const end = find(lon, lat);
    const where = [end.feature, end.country].filter(Boolean).join(", ") || end.wide;
    lines[1]!.textContent = opts.hours || !where ? ""
      : `${live ? "now over" : "last heard over"} ${where}`;
    endEl.querySelector("em")!.textContent = opts.cta ?? "";
  }

  // ---- the balloon and its trail ----
  /** Which steps of the path fall inside a silence. */
  const quietAt = new Uint8Array(path.count);
  for (let i = 0; i < path.count; i++) {
    quietAt[i] = path.at(path.startMs + spanMs * i / (path.count - 1)).heard ? 0 : 1;
  }
  /** A post for each report heard, thinned on a long flight to what the
   * frame can hold. */
  const posts: number[] = [];
  {
    const minGap = spanMs / chaseS / 14;
    let lastMs = -Infinity;
    for (const p of opts.track) {
      const ms = parseUtc(p.utc).getTime();
      if (ms < path.startMs || ms > path.endMs || ms - lastMs < minGap) continue;
      posts.push(path.index(ms));
      lastMs = ms;
    }
  }
  const launchLabel = /·\s*([^·(]+?)\s*(\(|$)/.exec(meta.tracker?.Launched ?? "")?.[1] ?? "Launch";

  type Clip = [number, number, number, number];
  function draw(): void {
    if (!camera) return;
    const { matrix: m, eye } = camera;
    const t = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const clip = (p: Vec3, km: number): Clip => {
      const g = toGlobe(p);
      const k = 1 + km / EARTH_KM;
      const x = g[0] * k;
      const y = g[1] * k;
      const z = g[2] * k;
      return [
        m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
        m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
        m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
        m[3]! * x + m[7]! * y + m[11]! * z + m[15]!,
      ];
    };
    /** True when the planet is between the eye and a point. */
    const hidden = (p: Vec3, km: number): boolean => {
      const g = toGlobe(p);
      const k = 1 + Math.max(km, 0.6) / EARTH_KM;
      const d: Vec3 = [g[0] * k - eye[0], g[1] * k - eye[1], g[2] * k - eye[2]];
      const a = dot(d, d);
      const b = 2 * dot(eye, d);
      const c = dot(eye, eye) - 1;
      const disc = b * b - 4 * a * c;
      if (disc <= 0) return false;
      const s = (-b - Math.sqrt(disc)) / (2 * a);
      return s > 0 && s < 0.9995;
    };
    const NEAR = 1e-5;
    const px = (c: Clip): [number, number] =>
      [(c[0] / c[3] * 0.5 + 0.5) * W, (0.5 - c[1] / c[3] * 0.5) * H];
    const cut = (a: Clip, b: Clip): Clip => {
      const f = (NEAR - a[3]) / (b[3] - a[3]);
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, NEAR];
    };
    /** Add a segment to the current path, cut where it passes behind the
     * lens. */
    const segment = (a: Clip, b: Clip) => {
      if (a[3] < NEAR && b[3] < NEAR) return;
      const p = a[3] < NEAR ? cut(a, b) : a;
      const r = b[3] < NEAR ? cut(b, a) : b;
      const [x0, y0] = px(p);
      const [x1, y1] = px(r);
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    };
    /** Add a line through points to the current path, as far as `ok`
     * allows, each run of it one connected stroke so that dashes run
     * along it. */
    const strand = (pts: Clip[], ok: (i: number) => boolean) => {
      let open = false;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        if (!ok(i) || (a[3] < NEAR && b[3] < NEAR)) { open = false; continue; }
        const p = a[3] < NEAR ? cut(a, b) : a;
        const r = b[3] < NEAR ? cut(b, a) : b;
        if (!open || p !== a) {
          const [x0, y0] = px(p);
          ctx.moveTo(x0, y0);
        }
        const [x1, y1] = px(r);
        ctx.lineTo(x1, y1);
        open = r === b;
      }
    };
    /** Fill a polygon, cut the same way. */
    const polygon = (pts: Clip[]) => {
      const out: Clip[] = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        if (a[3] >= NEAR) out.push(a);
        if ((a[3] >= NEAR) !== (b[3] >= NEAR)) out.push(cut(a, b));
      }
      if (out.length < 3) return;
      const [x0, y0] = px(out[0]!);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < out.length; i++) {
        const [x, y] = px(out[i]!);
        ctx.lineTo(x, y);
      }
      ctx.closePath();
    };

    const ms = flightMs(t);
    const s = path.at(ms);
    const upTo = path.index(ms);
    const drawnKm = s.altitudeM / 1000 * tall;
    const sun = sunVector(ms);
    const light = smooth(-0.12, 0.16, dot(s.pos, sun));
    const reveal = smooth(chaseS - COAST_S, seconds - 0.5, t);
    const line = W / 540;

    // The path so far, in the air and on the ground, with now on the end.
    const n = Math.floor(upTo) + 1;
    const air: Clip[] = [];
    const ground: Clip[] = [];
    const seen: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const p = path.pos(i);
      const km = path.alt(i) / 1000 * tall;
      air.push(clip(p, km));
      ground.push(clip(p, 0));
      seen.push(!hidden(p, km));
    }
    air.push(clip(s.pos, drawnKm));
    ground.push(clip(s.pos, 0));
    seen.push(true);
    const quiet = (i: number) => quietAt[Math.min(i, path.count - 1)] === 1;

    // The wall between them.
    for (const pass of [false, true]) {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (!seen[i] || !seen[i + 1] || quiet(i) !== pass) continue;
        polygon([air[i]!, air[i + 1]!, ground[i + 1]!, ground[i]!]);
      }
      ctx.fillStyle = pass ? "rgba(125, 211, 252, 0.05)" : "rgba(125, 211, 252, 0.13)";
      ctx.fill();
    }
    // Its foot on the ground.
    ctx.beginPath();
    strand(ground, (i) => seen[i]! && seen[i + 1]!);
    ctx.strokeStyle = "rgba(4, 10, 24, 0.5)";
    ctx.lineWidth = 2.2 * line;
    ctx.lineCap = "round";
    ctx.stroke();
    // A post for each report heard.
    ctx.beginPath();
    for (const at of posts) {
      if (at > upTo) break;
      const i = Math.round(at);
      if (seen[i]) segment(air[i]!, ground[i]!);
    }
    ctx.strokeStyle = "rgba(186, 230, 253, 0.34)";
    ctx.lineWidth = 0.9 * line;
    ctx.stroke();
    // The line itself: solid where it was heard, dashed across a silence.
    for (const pass of [true, false]) {
      ctx.save();
      ctx.beginPath();
      strand(air, (i) => seen[i]! && seen[i + 1]! && quiet(i) === pass);
      ctx.lineJoin = "round";
      ctx.shadowColor = "rgba(125, 211, 252, 0.9)";
      ctx.shadowBlur = (pass ? 4 : 10) * line * dpr;
      ctx.strokeStyle = pass ? "rgba(186, 230, 253, 0.7)" : "rgba(224, 244, 255, 0.98)";
      ctx.lineWidth = (pass ? 1.7 : 2.6) * line;
      if (pass) ctx.setLineDash([5 * line, 6 * line]);
      ctx.stroke();
      ctx.restore();
    }

    // Where it left from.
    const start = path.pos(0);
    if (!hidden(start, 0)) {
      const c = clip(start, 0);
      if (c[3] > NEAR) {
        const [x, y] = px(c);
        ctx.beginPath();
        ctx.arc(x, y, 5 * line, 0, Math.PI * 2);
        ctx.fillStyle = "#fbbf24";
        ctx.shadowColor = "rgba(251, 191, 36, 0.9)";
        ctx.shadowBlur = 10 * line * dpr;
        ctx.fill();
        ctx.shadowBlur = 0;
        if (reveal > 0.4) {
          ctx.globalAlpha = smooth(0.4, 0.8, reveal);
          ctx.font = `600 ${11 * line}px ui-monospace, "SF Mono", Menlo, monospace`;
          ctx.fillStyle = "#fde68a";
          ctx.textAlign = "left";
          ctx.fillText(launchLabel.toUpperCase(), x + 11 * line, y + 4 * line);
          ctx.globalAlpha = 1;
        }
      }
    }

    // The balloon, the ground under it, and the line between: its height.
    if (hidden(s.pos, drawnKm)) return;
    const top = clip(s.pos, drawnKm);
    const foot = clip(s.pos, 0);
    if (top[3] < NEAR) return;
    const [bx, by] = px(top);
    const radius = mix(0.052, 0.036, reveal) * W;
    if (foot[3] > NEAR && !hidden(s.pos, 0)) {
      const [fx, fy] = px(foot);
      // Its shadow: a patch of ground, in perspective.
      const east = norm(cross([0, 0, 1], s.pos));
      const north = cross(s.pos, east);
      const size = 0.05 * drawnPeakKm / EARTH_KM * mix(1, 3, reveal);
      ctx.save();
      ctx.filter = `blur(${2.5 * line * dpr}px)`;
      ctx.beginPath();
      const ring: Clip[] = [];
      for (let k = 0; k < 20; k++) {
        const ang = k / 20 * Math.PI * 2;
        ring.push(clip(travel(s.pos, add(scale(east, Math.cos(ang)), scale(north, Math.sin(ang))), size), 0));
      }
      polygon(ring);
      ctx.fillStyle = `rgba(2, 6, 16, ${mix(0.35, 0.62, light)})`;
      ctx.fill();
      ctx.restore();
      // The drop line, from the ground up to the end of the wire.
      const dx = bx - fx;
      const dy = by - fy;
      const length = Math.hypot(dx, dy);
      const clear = WIRE_END * radius;
      if (length > clear + 4) {
        const f = (length - clear) / length;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(fx + dx * f, fy + dy * f);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.62)";
        ctx.lineWidth = 1.1 * line;
        ctx.setLineDash([3 * line, 4 * line]);
        ctx.stroke();
        ctx.setLineDash([]);
        // A tick every so much real height: the scale the drawn height
        // is read against.
        const stepM = units === "imperial" ? 10000 / u.M_TO_FT : 2500;
        ctx.beginPath();
        for (let hM = stepM; hM < s.altitudeM; hM += stepM) {
          const c = clip(s.pos, hM / 1000 * tall);
          if (c[3] < NEAR) continue;
          const [tx, ty] = px(c);
          if (Math.hypot(tx - bx, ty - by) < clear + 3) continue;
          ctx.moveTo(tx - 5 * line, ty);
          ctx.lineTo(tx + 5 * line, ty);
        }
        ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
        ctx.lineWidth = 1.2 * line;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(fx, fy, 2.4 * line, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.fill();
    }
    drawBalloon(ctx, bx, by, {
      radius,
      fill: fillAt(s.altitudeM, floatM, groundM),
      light,
      sway: Math.sin(t * 1.7) * 0.035,
    });
  }

  // ---- frames ----
  function frame(t: number): void {
    now = Math.min(seconds, Math.max(0, t));
    const pose = poseAtTime(now);
    map.jumpTo(aim(pose, H));
    drawHud(now);
    map.triggerRepaint();
  }

  let raf = 0;
  const onResize = () => { resize(); map.resize(); frame(now); };
  const reel: Reel = {
    seconds,
    lights: !!nightPicture,
    seek(t) {
      frame(t);
      return new Promise<void>((resolve) => {
        const timer = setTimeout(done, 15000);
        function done() {
          clearTimeout(timer);
          map.off("idle", done);
          resolve();
        }
        map.on("idle", done);
      });
    },
    play() {
      cancelAnimationFrame(raf);
      const t0 = performance.now();
      const tick = () => {
        const t = ((performance.now() - t0) / 1000) % (seconds + 1.5);
        frame(Math.min(t, seconds));
        raf = requestAnimationFrame(tick);
      };
      tick();
    },
    stop() { cancelAnimationFrame(raf); },
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      map.remove();
      style.remove();
      container.innerHTML = "";
    },
  };
  window.addEventListener("resize", onResize);
  await reel.seek(0);
  return reel;
}
