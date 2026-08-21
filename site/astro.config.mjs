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
});
