/** Load the live flight page in a real browser and assert the things a
 * typecheck cannot: that the map actually draws, that it survives the
 * refresh cycle, and that no JS error is thrown along the way.
 *
 * It also checks that the weather overlay's chosen layer survives a refresh,
 * which is the same class of bug: the control is rebuilt with the map.
 *
 * This exists because a refresh used to blank the map. Leaflet stamps its
 * container with a _leaflet_id and refuses to initialise it twice, so
 * emptying the element and re-rendering threw and left a sized but empty
 * box. Nothing in the build or the typecheck could see that.
 *
 * Needs a running dev server (npm run dev) and the system Chrome.
 * Run:  npm run browser-check
 */
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

await page.goto("http://localhost:4321/live/F1B/", { waitUntil: "networkidle" });

const probe = async (label) => {
  const r = await page.evaluate(() => {
    const slot = document.querySelector(".fv-map-slot");
    return {
      height: slot ? Math.round(slot.getBoundingClientRect().height) : 0,
      tiles: document.querySelectorAll(".leaflet-tile").length,
      loadedTiles: document.querySelectorAll(".leaflet-tile-loaded").length,
      markers: document.querySelectorAll(".leaflet-marker-icon, canvas.leaflet-zoom-animated").length,
      hasLeafletPane: !!document.querySelector(".leaflet-map-pane"),
      cards: document.querySelectorAll(".fv-card").length,
      activeCard: document.querySelector('.fv-card[aria-pressed="true"]')
        ?.dataset.metric,
      updated: document.getElementById("updated")?.textContent?.trim().slice(0, 60),
    };
  });
  console.log(`${label}: height=${r.height}px tiles=${r.tiles} (loaded ${r.loadedTiles}) ` +
    `leafletPane=${r.hasLeafletPane} cards=${r.cards} active=${r.activeCard}`);
  console.log(`   updated: ${r.updated}`);
  return r;
};

const first = await probe("initial paint    ");

// Force the exact path that was breaking it: a refresh that adds points.
await page.evaluate(() => document.getElementById("refresh").click());
await page.waitForTimeout(4000);
const after = await probe("after refresh    ");

// And a second refresh, to catch anything that only breaks on repeat.
await page.evaluate(() => document.getElementById("refresh").click());
await page.waitForTimeout(4000);
const twice = await probe("after 2nd refresh");

// Pressing a card is the new core interaction: the map recolors by that
// metric and the panel opens with its chart. Both have to survive a refresh
// too, since the sidebar is re-rendered and the map rebuilt around them.
await page.evaluate(() =>
  document.querySelector('.fv-card[data-metric="speed"]').click());
await page.waitForTimeout(1500);
const panelProbe = async (label) => {
  const r = await page.evaluate(() => ({
    open: !document.getElementById("panel").hidden,
    title: document.getElementById("panel-title")?.textContent?.trim(),
    chart: !!document.querySelector(".fv-panel-chart svg"),
    active: document.querySelector('.fv-card[aria-pressed="true"]')
      ?.dataset.metric,
    legend: document.querySelector(".map-legend-name")?.textContent?.trim(),
  }));
  console.log(`${label}: open=${r.open} title=${r.title} chart=${r.chart} ` +
    `active=${r.active} legend=${r.legend}`);
  return r;
};
const panelOn = await panelProbe("speed card       ");
await page.evaluate(() => document.getElementById("refresh").click());
await page.waitForTimeout(4000);
const panelAfter = await panelProbe("speed, refresh   ");
const panelOk =
  panelOn.open && panelOn.title === "Ground speed" && panelOn.chart &&
  panelOn.active === "speed" && panelOn.legend === "Ground speed" &&
  panelAfter.open && panelAfter.active === "speed" &&
  panelAfter.legend === "Ground speed";
await page.evaluate(() => document.getElementById("panel-close").click());

// The tracker card opens a text panel, no chart, no range toggle.
await page.evaluate(() =>
  document.querySelector('[data-panel="tracker"]').click());
const tracker = await page.evaluate(() => ({
  open: !document.getElementById("panel").hidden,
  minis: document.querySelectorAll(".fv-tracker .fv-mini").length,
  rangeHidden: document.querySelector(".fv-panel .range-toggle").hidden,
}));
console.log(`tracker card     : open=${tracker.open} minis=${tracker.minis} ` +
  `rangeHidden=${tracker.rangeHidden}`);
const trackerOk = tracker.open && tracker.minis > 5 && tracker.rangeHidden;
await page.evaluate(() => document.getElementById("panel-close").click());

// The weather layer is the other thing a rebuilt map can lose. Its control
// is created fresh with each map, so the chosen layer has to be handed back
// in or a refresh quietly switches it off under the reader.
const setWeather = async (label) => {
  await page.evaluate((l) => {
    [...document.querySelectorAll(".weather-toggle:not(.view-toggle) button")]
      .find((b) => b.textContent === l)?.click();
  }, label);
  await page.waitForTimeout(4000);
};
const weatherProbe = async (label) => {
  const r = await page.evaluate(() => ({
    // :not(.view-toggle): the flat/globe switch wears the same pill class.
    on: document.querySelector('.weather-toggle:not(.view-toggle) button[aria-pressed="true"]')?.textContent,
    buttons: document.querySelectorAll(".weather-toggle:not(.view-toggle) button").length,
    tiles: document.querySelectorAll(".weather-tiles .leaflet-tile-loaded").length,
  }));
  console.log(`${label}: on=${r.on} buttons=${r.buttons} weatherTiles=${r.tiles}`);
  return r;
};

await setWeather("Clouds");
const wx = await weatherProbe("weather on       ");
await page.evaluate(() => document.getElementById("refresh").click());
await page.waitForTimeout(4000);
const wxAfter = await weatherProbe("weather, refresh ");
// The tiles come from third parties: the count is reported, never asserted,
// so someone else's outage cannot fail our check. The state surviving the
// rebuild is the part that is ours.
const weatherOk =
  wx.buttons === 3 && wx.on === "Clouds" && wxAfter.on === "Clouds";
await setWeather("Off");

await page.screenshot({ path: "dev/browser-check.png", fullPage: false });

// The globe is the other renderer entirely: maplibre, lazy-loaded on first
// use. Switching must swap Leaflet's panes for a canvas, survive the same
// refresh rebuild as everything else (the view choice is held outside the
// map), keep the weather switch on offer, and switch back cleanly.
const setView = async (label) => {
  await page.evaluate((l) => {
    [...document.querySelectorAll(".view-toggle button")]
      .find((b) => b.textContent === l)?.click();
  }, label);
  await page.waitForTimeout(4000);
};
const viewProbe = async (label) => {
  const r = await page.evaluate(() => ({
    on: document.querySelector('.view-toggle button[aria-pressed="true"]')?.textContent,
    canvas: !!document.querySelector(".maplibregl-canvas"),
    leaflet: !!document.querySelector(".leaflet-map-pane"),
    weatherButtons: document.querySelectorAll(".weather-toggle:not(.view-toggle) button").length,
    search: location.search,
  }));
  console.log(`${label}: on=${r.on} canvas=${r.canvas} leaflet=${r.leaflet} ` +
    `weatherButtons=${r.weatherButtons} search=${r.search || "(none)"}`);
  return r;
};
await setView("Globe");
const gOn = await viewProbe("globe on         ");
await page.screenshot({ path: "dev/browser-check-globe.png", fullPage: false });
await page.evaluate(() => document.getElementById("refresh").click());
await page.waitForTimeout(4000);
const gAfter = await viewProbe("globe, refresh   ");
await setView("Flat");
const gOff = await viewProbe("flat again       ");
const globeOk =
  gOn.canvas && !gOn.leaflet && gOn.on === "Globe" && gOn.weatherButtons === 3 &&
  gAfter.canvas && gAfter.on === "Globe" &&
  gOff.leaflet && !gOff.canvas && gOff.on === "Flat";

// Trackpad zoom is not something a typecheck can see. Leaflet's own handler
// batches 40 ms of wheel events and applies them in one jump, which turns a
// two-finger swipe into about one zoom level; map.ts replaces it with a
// continuous one. Read the zoom back out of the DOM -- tile level plus the
// log of the container's scale -- since the map lives in a module closure.
const zoomNow = () => page.evaluate(() => {
  const c = document.querySelector(".leaflet-tile-container");
  const t = document.querySelector(".leaflet-tile");
  if (!c || !t) return null;
  const m = new DOMMatrixReadOnly(getComputedStyle(c).transform);
  const z = Number(t.src.match(/\/(\d+)\/\d+\/\d+/)?.[1]);
  return Number((z + Math.log2(m.a || 1)).toFixed(3));
});
const swipe = async (deltaY, count) => {
  const before = await zoomNow();
  // Sample the loaded-tile count *during* the gesture. Zooming with setView
  // per frame aborts each frame's tile requests, so the map goes black under
  // the reader's fingers; the pinch path transforms what is on screen and
  // this stays healthy throughout.
  const min = await page.evaluate(async ({ deltaY, count }) => {
    const el = document.querySelector(".leaflet-container");
    const r = el.getBoundingClientRect();
    let lowest = Infinity;
    for (let i = 0; i < count; i++) {
      el.dispatchEvent(new WheelEvent("wheel", {
        deltaY, deltaMode: 0, bubbles: true, cancelable: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }));
      await new Promise((done) => setTimeout(done, 16));
      lowest = Math.min(lowest, document.querySelectorAll(".leaflet-tile-loaded").length);
    }
    return lowest;
  }, { deltaY, count });
  await page.waitForTimeout(400);
  return { moved: (await zoomNow()) - before, tilesDuring: min };
};
const inSwipe = await swipe(-4.2, 40);
const outSwipe = await swipe(4.2, 40);
console.log(`wheel zoom       : in=${inSwipe.moved.toFixed(2)} out=${outSwipe.moved.toFixed(2)} levels ` +
  `tiles during gesture>=${Math.min(inSwipe.tilesDuring, outSwipe.tilesDuring)}`);
// The map must move, come back to where it started, and never blank out on
// the way. The exact rate is a matter of taste and lives in map.ts.
const wheelOk =
  inSwipe.moved > 0.4 && outSwipe.moved < -0.4 &&
  Math.abs(inSwipe.moved + outSwipe.moved) < 0.05 &&
  inSwipe.tilesDuring > 0 && outSwipe.tilesDuring > 0;

// A link is the last piece of shared state: `?p=speed` has to arrive with
// the speed panel open and the map colored by it, without rewriting the URL
// that asked for it, and closing a panel has to take the parameter back out
// so the next copy of the URL shares the empty view it shows.
const linkProbe = async (label) => {
  const r = await page.evaluate(() => ({
    search: location.search,
    open: !document.getElementById("panel").hidden,
    title: document.getElementById("panel-title")?.textContent?.trim(),
    legend: document.querySelector(".map-legend-name")?.textContent?.trim(),
  }));
  console.log(`${label}: search=${r.search || "(none)"} open=${r.open} ` +
    `title=${r.title} legend=${r.legend}`);
  return r;
};
await page.goto("http://localhost:4321/live/F1B/?p=speed", { waitUntil: "networkidle" });
await page.waitForSelector(".map-legend-name", { timeout: 10000 }).catch(() => {});
const linked = await linkProbe("link ?p=speed    ");
await page.evaluate(() => document.getElementById("panel-close").click());
const linkClosed = await linkProbe("link, closed     ");
const linkOk =
  linked.search === "?p=speed" && linked.open &&
  linked.title === "Ground speed" && linked.legend === "Ground speed" &&
  !linkClosed.open && linkClosed.search === "";
console.log(`\nJS errors: ${errors.length ? "\n  " + errors.join("\n  ") : "none"}`);
const ok = after.hasLeafletPane && after.height > 200 && after.tiles > 0
  && twice.hasLeafletPane && twice.tiles > 0 && twice.cards === 7
  && panelOk && trackerOk && weatherOk && globeOk && linkOk && wheelOk
  && errors.length === 0;
console.log(ok
  ? "\nRESULT: map, panel, weather and globe survive refreshes; links share the panel"
  : "\nRESULT: STILL BROKEN");
await browser.close();
process.exit(ok ? 0 : 1);
