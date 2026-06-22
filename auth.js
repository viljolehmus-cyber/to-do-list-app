/* ==========================================================================
   auth.js — authentication.

   CLOUD mode (Supabase configured): real email+password auth with email
   confirmation, password reset, OAuth, session persistence and auto token
   refresh. The browser only ever holds the public anon key; Row-Level
   Security (server-side) is what keeps data private — the client is never
   trusted.

   LOCAL mode (Supabase not configured): the original on-device demo auth so
   the app keeps working before you connect a backend. Clearly NOT secure;
   accounts live in localStorage. See SETUP.md to switch on the real backend.

   Either way the public API is the same (async), and currentUser() stays
   synchronous by caching the active session.
   ========================================================================== */

import { sb, cloud } from './supa.js';
import * as db from './storage.js';
import { DEMO_EMAIL, DEMO_PASSWORD } from './config.js';

export { cloud };

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
export const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
const fail = (field, error) => ({ ok: false, field, error });

/** Where Supabase should send users back after email links / OAuth. */
export function redirectURL() {
  return window.location.origin + window.location.pathname;
}

/* ---------- cached session ---------- */

let sessionUser = null; // { id, email, name } or null
const listeners = new Set();

function setSession(user) {
  sessionUser = user;
  db.setScope(user ? user.id : null);
}

export function currentUser() { return sessionUser; }
export function isLoggedIn() { return !!sessionUser; }
export function onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function notify(event) { listeners.forEach((cb) => cb(event, sessionUser)); }

/* ---------- init / session restore ---------- */

export async function init() {
  if (cloud) {
    const { data } = await sb.auth.getSession();
    applySupa(data.session);
    sb.auth.onAuthStateChange((event, session) => {
      applySupa(session);
      notify(event);
    });
  } else {
    const id = lread('taskly.session', null);
    const acc = id ? localAccounts().find((a) => a.id === id) : null;
    setSession(acc ? { id: acc.id, email: acc.email, name: acc.name } : null);
  }
  return sessionUser;
}

function applySupa(session) {
  if (session && session.user) {
    setSession({
      id: session.user.id,
      email: session.user.email,
      name: session.user.user_metadata?.name || '',
    });
  } else {
    setSession(null);
  }
}

/* ---------- sign up ---------- */

export async function signUp({ name, email, password, confirm }) {
  name = String(name || '').trim();
  const e = normalizeEmail(email);
  if (!name) return fail('name', 'Please enter your name.');
  if (!e || !isValidEmail(e)) return fail('email', 'Enter a valid email address.');
  if (!password || password.length < 6) return fail('password', 'Use at least 6 characters.');
  if (confirm !== undefined && password !== confirm) return fail('confirm', 'Passwords don’t match.');

  if (cloud) {
    try {
      const { data, error } = await sb.auth.signUp({
        email: e, password,
        options: { data: { name }, emailRedirectTo: redirectURL() },
      });
      if (error) return mapError(error);
      // No session yet → email confirmation required.
      if (!data.session) return { ok: true, needsConfirmation: true, email: e };
      return { ok: true, user: sessionUser };
    } catch { return netError(); }
  }

  // local mode
  if (localAccounts().some((a) => a.email === e)) {
    return fail('email', 'An account with this email already exists.');
  }
  const acc = { id: db.uid(), name, email: e, pass: lightHash(password), createdAt: new Date().toISOString() };
  const list = localAccounts(); list.push(acc); saveLocalAccounts(list);
  lwrite('taskly.session', acc.id);
  setSession({ id: acc.id, email: acc.email, name: acc.name });
  return { ok: true, user: sessionUser };
}

/* ---------- log in ---------- */

export async function signIn({ email, password }) {
  const e = normalizeEmail(email);
  if (!e) return fail('email', 'Please enter your email.');
  if (!password) return fail('password', 'Please enter your password.');

  if (cloud) {
    try {
      const { error } = await sb.auth.signInWithPassword({ email: e, password });
      if (error) return mapError(error);
      return { ok: true, user: sessionUser };
    } catch { return netError(); }
  }

  const acc = localAccounts().find((a) => a.email === e);
  if (!acc) return fail('email', 'No account found with this email.');
  if (acc.pass !== lightHash(password)) return fail('password', 'Incorrect password. Try again.');
  lwrite('taskly.session', acc.id);
  setSession({ id: acc.id, email: acc.email, name: acc.name });
  return { ok: true, user: sessionUser };
}
export const logIn = signIn; // backwards-compatible alias

export async function signInWithGoogle() {
  if (!cloud) return fail('form', 'Google sign-in needs the cloud backend (see SETUP.md).');
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: redirectURL() },
    });
    if (error) return mapError(error);
    return { ok: true }; // browser redirects away
  } catch { return netError(); }
}

/* ---------- password reset / change ---------- */

export async function resetPassword(email) {
  const e = normalizeEmail(email);
  if (!e || !isValidEmail(e)) return fail('email', 'Enter a valid email address.');
  if (!cloud) return fail('form', 'Password reset needs the cloud backend (see SETUP.md).');
  try {
    const { error } = await sb.auth.resetPasswordForEmail(e, { redirectTo: redirectURL() });
    if (error) return mapError(error);
    return { ok: true };
  } catch { return netError(); }
}

export async function updatePassword(newPassword) {
  if (!newPassword || newPassword.length < 6) return fail('password', 'Use at least 6 characters.');
  if (cloud) {
    try {
      const { error } = await sb.auth.updateUser({ password: newPassword });
      if (error) return mapError(error);
      return { ok: true };
    } catch { return netError(); }
  }
  const list = localAccounts();
  const acc = list.find((a) => a.id === sessionUser?.id);
  if (!acc) return fail('form', 'Not signed in.');
  acc.pass = lightHash(newPassword); saveLocalAccounts(list);
  return { ok: true };
}

/* ---------- profile / sign out / delete ---------- */

export async function updateName(name) {
  name = String(name || '').trim();
  if (sessionUser) sessionUser.name = name;
  db.saveSettings({ name });
  if (cloud) {
    try { await sb.auth.updateUser({ data: { name } }); } catch { /* will retry on next edit */ }
  } else {
    const list = localAccounts();
    const acc = list.find((a) => a.id === sessionUser?.id);
    if (acc) { acc.name = name; saveLocalAccounts(list); }
  }
}

export async function signOut() {
  if (cloud) { try { await sb.auth.signOut(); } catch { /* clear locally anyway */ } }
  else lwrite('taskly.session', null);
  setSession(null);
}
export const logOut = signOut;

export async function deleteAccount() {
  if (cloud) {
    try {
      const { error } = await sb.rpc('delete_user'); // SECURITY DEFINER (see SETUP.md)
      if (error) return mapError(error);
      await sb.auth.signOut();
    } catch { return netError(); }
  } else {
    db.clearAll();
    saveLocalAccounts(localAccounts().filter((a) => a.id !== sessionUser?.id));
    lwrite('taskly.session', null);
  }
  setSession(null);
  return { ok: true };
}

/* ---------- onboarding flag (stored in settings, synced) ---------- */

export function hasSeenOnboarding() { return !!db.getSettings().onboardingSeen; }
export function setOnboardingSeen() { db.saveSettings({ onboardingSeen: true }); }

/* ---------- dev demo shortcut ---------- */

export async function loginDemo() {
  if (cloud) return signIn({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
  let acc = localAccounts().find((a) => a.email === DEMO_EMAIL);
  if (!acc) {
    acc = { id: db.uid(), name: 'Alex', email: DEMO_EMAIL, pass: lightHash(DEMO_PASSWORD), createdAt: new Date().toISOString() };
    const list = localAccounts(); list.push(acc); saveLocalAccounts(list);
  }
  lwrite('taskly.session', acc.id);
  setSession({ id: acc.id, email: acc.email, name: acc.name });
  return { ok: true, user: sessionUser };
}

/* ---------- error mapping ---------- */

function mapError(error) {
  const m = (error?.message || '').toLowerCase();
  if (m.includes('already registered') || m.includes('already been registered')) return fail('email', 'An account with this email already exists.');
  if (m.includes('invalid login')) return fail('password', 'Incorrect email or password.');
  if (m.includes('email not confirmed')) return fail('email', 'Please confirm your email first — check your inbox.');
  if (m.includes('password should be')) return fail('password', 'Use at least 6 characters.');
  if (m.includes('rate limit') || m.includes('too many')) return fail('form', 'Too many attempts. Please wait a moment and try again.');
  if (m.includes('redirect')) return fail('form', 'This site isn’t an allowed redirect URL yet (see SETUP.md).');
  return fail('form', error?.message || 'Something went wrong. Please try again.');
}
function netError() { return fail('form', 'Network error — check your connection and try again.'); }

/* ---------- LOCAL-mode helpers (NOT secure; obfuscation only) ---------- */

function lread(k, fb) { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fb; } catch { return fb; } }
function lwrite(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function localAccounts() { return lread('taskly.accounts', []); }
function saveLocalAccounts(list) { lwrite('taskly.accounts', list); }

/** Trivial non-cryptographic hash — local mode only, NOT real security. */
function lightHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return `lh1$${h.toString(36)}`;
}
