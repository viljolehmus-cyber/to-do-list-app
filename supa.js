/* ==========================================================================
   supa.js — the single Supabase client instance (or null in local mode).

   The supabase-js bundle is vendored at vendor/supabase.js and loaded as a
   plain <script> before the app module, exposing window.supabase. We read
   it here so nothing is fetched from a CDN (the PWA stays offline-capable
   and the service worker can cache everything).
   ========================================================================== */

import { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from './config.js';

/** True → Supabase is configured and we run in cloud mode. */
export const cloud = isConfigured();

let client = null;

if (cloud) {
  const lib = (typeof window !== 'undefined') ? window.supabase : null;
  if (!lib || typeof lib.createClient !== 'function') {
    console.error('[supa] vendor/supabase.js did not load — check the <script> tag in index.html');
  } else {
    client = lib.createClient(SUPABASE_URL.trim(), SUPABASE_ANON_KEY.trim(), {
      auth: {
        persistSession: true,     // keep the session in localStorage
        autoRefreshToken: true,   // refresh the access token in the background
        detectSessionInUrl: true, // complete OAuth / email-link redirects
        storageKey: 'taskly.auth',
        flowType: 'pkce',
      },
    });
  }
}

/** The Supabase client, or null when running in local mode. */
export const sb = client;
