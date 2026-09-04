/** Prefix a site-relative path with the configured base path, so links and
 * fetches work both at root and under a GitHub Pages project path. */
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL;
  return (base.endsWith("/") ? base : base + "/") + path.replace(/^\//, "");
}
