/** Load the live flight page in a real browser and assert the things a
 * typecheck cannot: that the map actually draws, that it survives the
 * refresh cycle, and that no JS error is thrown along the way.
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
      detailsCount: document.querySelectorAll(".fv-table-slot details").length,
      rows: document.querySelectorAll(".fv-table-slot tbody tr").length,
      updated: document.getElementById("updated")?.textContent?.trim().slice(0, 60),
    };
  });
  console.log(`${label}: height=${r.height}px tiles=${r.tiles} (loaded ${r.loadedTiles}) ` +
    `leafletPane=${r.hasLeafletPane} details=${r.detailsCount} tableRows=${r.rows}`);
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

await page.screenshot({ path: "dev/browser-check.png", fullPage: false });
console.log(`\nJS errors: ${errors.length ? "\n  " + errors.join("\n  ") : "none"}`);
const ok = after.hasLeafletPane && after.height > 200 && after.tiles > 0
  && twice.hasLeafletPane && twice.tiles > 0 && twice.detailsCount === 1 && errors.length === 0;
console.log(ok ? "\nRESULT: map survives refreshes" : "\nRESULT: STILL BROKEN");
await browser.close();
process.exit(ok ? 0 : 1);
