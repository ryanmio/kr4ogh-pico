// Render dev/og.svg to public/og.png, the share-card image. Social sites
// will not take an SVG, so the PNG is committed; run this after editing the
// SVG. The card names no callsign on purpose: one image serves every
// instance of the site. Needs the system Chrome, like browser-check.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto("file://" + join(here, "og.svg"));
const out = join(here, "../public/og.png");
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
