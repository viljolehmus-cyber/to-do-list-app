/* ==========================================================================
   auth.js — LOCAL DEMO AUTH.  ⚠️  NOT REAL SECURITY.

   This is client-side-only demo authentication. There is NO backend and
   NO server. "Accounts" — including passwords — are stored in this
   browser's localStorage. Passwords are run through a trivial,
   non-cryptographic hash (`lightHash`) purely so they aren't sitting in
   plain text in DevTools. That is OBFUSCATION, NOT ENCRYPTION, and gives
   NO real protection: anyone with access to this browser profile can read
   or modify everything here. Never reuse a real password, and never ship
   this as production authentication.

   Account shape:
   { id, name, email, pass, createdAt, onboardingSeen }
   ========================================================================== */

import { uid } from './storage.js';

const KEYS = {
  accounts: 'taskly.accounts', // array of account objects
  session:  'taskly.session',  // id of the currently logged-in account, or null
};

/** Email used by the dev-only demo account (see entry.js DEV_MODE). */
export const DEMO_EMAIL = 'demo@taskly.app';

/* ---------- tiny localStorage helpers ---------- */

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (err) { console.warn('[auth] could not persist:', err); }
}

/**
 * Trivial, NON-cryptographic hash (djb2 variant). This exists only to keep
 * passwords from being trivially readable as plain text — it is NOT secure
 * and must never be mistaken for real password hashing.
 */
function lightHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; // h * 33 + c
  }
  return `lh1$${h.toString(36)}`;
}

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
export const normalizeEmail = (e) => String(e || '').trim().toLowerCase();

/* ---------- accounts ---------- */

export function getAccounts() { return read(KEYS.accounts, []); }
function saveAccounts(list) { write(KEYS.accounts, list); }

export function findByEmail(email) {
  const e = normalizeEmail(email);
  return getAccounts().find((a) => a.email === e) || null;
}

export function currentUser() {
  const id = read(KEYS.session, null);
  if (!id) return null;
  return getAccounts().find((a) => a.id === id) || null;
}

export function isLoggedIn() { return !!currentUser(); }

/* ---------- sign up / log in / log out ----------
   Each returns { ok: true, user } on success, or
   { ok: false, field, error } so the UI can show inline validation. */

export function signUp({ name, email, password, confirm }) {
  name = String(name || '').trim();
  const e = normalizeEmail(email);

  if (!name)                       return fail('name', 'Please enter your name.');
  if (!e)                          return fail('email', 'Please enter your email.');
  if (!isValidEmail(e))            return fail('email', 'That doesn’t look like a valid email.');
  if (findByEmail(e))              return fail('email', 'An account with this email already exists.');
  if (!password)                   return fail('password', 'Please choose a password.');
  if (password.length < 6)         return fail('password', 'Use at least 6 characters.');
  if (password !== confirm)        return fail('confirm', 'Passwords don’t match.');

  const user = {
    id: uid(),
    name,
    email: e,
    pass: lightHash(password),
    createdAt: new Date().toISOString(),
    onboardingSeen: false,
  };
  const list = getAccounts();
  list.push(user);
  saveAccounts(list);
  write(KEYS.session, user.id);
  return { ok: true, user };
}

export function logIn({ email, password }) {
  const e = normalizeEmail(email);
  if (!e) return fail('email', 'Please enter your email.');
  if (!password) return fail('password', 'Please enter your password.');

  const user = findByEmail(e);
  if (!user) return fail('email', 'No account found with this email.');
  if (user.pass !== lightHash(password)) return fail('password', 'Incorrect password. Try again.');

  write(KEYS.session, user.id);
  return { ok: true, user };
}

export function logOut() { write(KEYS.session, null); }

const fail = (field, error) => ({ ok: false, field, error });

/* ---------- onboarding flag (per account) ---------- */

export function hasSeenOnboarding(userOrId) {
  const u = typeof userOrId === 'string'
    ? getAccounts().find((a) => a.id === userOrId)
    : userOrId;
  return !!(u && u.onboardingSeen);
}

export function setOnboardingSeen(id) {
  const list = getAccounts();
  const u = list.find((a) => a.id === id);
  if (u && !u.onboardingSeen) { u.onboardingSeen = true; saveAccounts(list); }
}

/** Keeps the account name in sync when the user edits it in Settings. */
export function updateName(id, name) {
  const list = getAccounts();
  const u = list.find((a) => a.id === id);
  if (u) { u.name = String(name || '').trim(); saveAccounts(list); }
}

/* ---------- dev-only demo account ----------
   Created on demand by the "Skip (dev)" button. It reuses whatever sample
   tasks/categories storage.js already seeded on this device, so it looks
   alive immediately. */
export function loginDemo() {
  let demo = findByEmail(DEMO_EMAIL);
  if (!demo) {
    demo = {
      id: uid(),
      name: 'Alex',
      email: DEMO_EMAIL,
      pass: lightHash('demo1234'),
      createdAt: new Date().toISOString(),
      onboardingSeen: false,
    };
    const list = getAccounts();
    list.push(demo);
    saveAccounts(list);
  }
  write(KEYS.session, demo.id);
  return demo;
}
