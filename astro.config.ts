import mdx from "@astrojs/mdx";
import { defineConfig } from "astro/config";
import { siteConfig } from "./src/lib/config";

// `site` has to be the real host: og:image and canonical are absolute URLs,
// and a card pointing at localhost shows nothing. flights.toml can name it;
// otherwise SITE_URL, then the production host Vercel names for every build
// (lib/config.ts). SITE_BASE is for a deploy under a subpath.
export default defineConfig({
  site: siteConfig.url ?? "http://localhost:4321",
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
