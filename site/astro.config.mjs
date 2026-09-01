// @ts-check
import mdx from "@astrojs/mdx";
import { defineConfig } from "astro/config";

// `site` has to be the real host: og:image and canonical are absolute URLs,
// and a card pointing at localhost shows nothing. Vercel serves this domain,
// so it is the default rather than an env var nothing sets; SITE_URL /
// SITE_BASE still override for a deploy somewhere else, under a subpath.
export default defineConfig({
  site: process.env.SITE_URL || "https://kr4ogh-pico.vercel.app",
  base: process.env.SITE_BASE || "/",
  integrations: [mdx()],
  vite: {
    // maplibre is only ever loaded through a dynamic import (the globe
    // view). Left to discover it on first use, Vite's dev server optimizes
    // it then and forces a full page reload, which lands mid-toggle and
    // throws the reader's state away. Pre-bundling it keeps the first
    // "Globe" press a normal code-split load.
    optimizeDeps: { include: ["maplibre-gl"] },
  },
});
