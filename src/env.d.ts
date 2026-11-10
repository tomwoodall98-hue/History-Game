/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL, e.g. https://abcd.supabase.co. Optional: no stats without it. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase publishable (anon) key. Never the secret or service-role key. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
