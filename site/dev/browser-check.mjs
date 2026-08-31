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

// The weather layer is the other thing a rebuilt map can lose. Its control
// is created fresh with each map, so the chosen layer has to be handed back
// in or a refresh quietly switches it off under the reader.
const setWeather = async (label) => {
  await page.evaluate((l) => {
    [...document.querySelectorAll(".weather-toggle button")]
      .find((b) => b.textContent === l)?.click();
  }, label);
  await page.waitForTimeout(4000);
};
const weatherProbe = async (label) => {
  const r = await page.evaluate(() => ({
    on: document.querySelector('.weather-toggle button[aria-pressed="true"]')?.textContent,
    buttons: document.querySelectorAll(".weather-toggle button").length,
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
console.log(`\nJS errors: ${errors.length ? "\n  " + errors.join("\n  ") : "none"}`);
const ok = after.hasLeafletPane && after.height > 200 && after.tiles > 0
  && twice.hasLeafletPane && twice.tiles > 0 && twice.cards === 6
  && panelOk && weatherOk && errors.length === 0;
console.log(ok
  ? "\nRESULT: map, panel and weather layer survive refreshes"
  : "\nRESULT: STILL BROKEN");
await browser.close();
process.exit(ok ? 0 : 1);
