/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
  /** Supabase project URL, e.g. https://xyz.supabase.co (optional). */
  readonly PUBLIC_SUPABASE_URL?: string;
  /** Supabase anon (or publishable) key. Read-only: RLS grants anon SELECT only. */
  readonly PUBLIC_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
