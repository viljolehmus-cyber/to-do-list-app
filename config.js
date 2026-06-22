/* ==========================================================================
   config.js — Supabase connection settings.

   HOW TO FILL THIS IN: see SETUP.md (step "Paste your project URL + anon
   key"). Until both values are set, the app runs in LOCAL MODE (accounts
   and data stay on this device, exactly like the original demo) so it
   keeps working before you connect a backend.

   ──────────────────────────────────────────────────────────────────────
   SECURITY
   • The "anon public" key below is DESIGNED to be shipped in client code.
     It is safe to expose **only because Row-Level Security (RLS) is
     enabled** on every table (the SQL in SETUP.md does this). RLS is what
     actually keeps each user's rows private.
   • NEVER put the `service_role` / secret key in here or anywhere in the
     client — it bypasses RLS and would expose every user's data. It must
     only ever live on a server you control.
   ────────────────────────────────────────────────────────────────────── */

export const SUPABASE_URL = '';      // e.g. 'https://abcd1234.supabase.co'
export const SUPABASE_ANON_KEY = ''; // the "anon public" key (NOT service_role)

/** True once both values look real → the app uses Supabase (cloud mode). */
export const isConfigured = () =>
  /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(SUPABASE_URL.trim()) &&
  SUPABASE_ANON_KEY.trim().length > 30;

/* ──────────────────────────────────────────────────────────────────────
   DEV_MODE — a "Skip → Demo account" button on the welcome screen.
   MUST be false for production. When true, it signs in with the demo
   credentials below (which must exist as a real account in cloud mode).
   ────────────────────────────────────────────────────────────────────── */
export const DEV_MODE = false;
export const DEMO_EMAIL = 'demo@taskly.app';
export const DEMO_PASSWORD = 'demo-taskly-1234';
