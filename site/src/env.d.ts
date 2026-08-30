/// <reference path="../.astro/types.d.ts" />

// The site reads no secrets and no service credentials. Flight data comes
// from committed files under src/data/ and, in the browser, straight from
// wspr.live's public endpoint. SITE_URL / SITE_BASE are supplied by the
// Pages build (see .github/workflows/site.yml) and consumed by Astro itself.
