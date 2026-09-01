// @ts-check
import mdx from "@astrojs/mdx";
import { defineConfig } from "astro/config";

// SITE_URL / SITE_BASE let the deploy workflow target GitHub Pages
// (https://<owner>.github.io/kr4ogh-pico with base /kr4ogh-pico/) without
// hardcoding a host here. Local dev defaults to root.
export default defineConfig({
  site: process.env.SITE_URL || "http://localhost:4321",
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
