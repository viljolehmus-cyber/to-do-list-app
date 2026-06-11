/* ==========================================================================
   notifications.js — local reminders via the Notification API.

   LIMITATION (by design, documented for future maintainers):
   True push notifications to a *closed* app require a push server (Web
   Push / VAPID) and a backend — this app is intentionally backend-free.
   So we implement *local* notifications instead: while the app is open
   (in a tab, or installed to the home screen and running) we check every
   ~20 seconds whether a reminder has come due and fire a system
   notification through the service worker registration when possible.
   ========================================================================== */

import * as db from './storage.js';
import { dueDateTime } from './suggestions.js';

const CHECK_INTERVAL_MS = 20 * 1000;
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // ignore reminders older than 12h

let getTasksRef = null;

/* ---------- permission ---------- */

export function supported() {
  return 'Notification' in window;
}

export function permission() {
  return supported() ? Notification.permission : 'unsupported';
}

export async function requestPermission() {
  if (!supported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/* ---------- firing ---------- */

async function show(title, body, tag) {
  const options = {
    body,
    tag,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
  };
  // Prefer the service worker so notifications also work when the page
  // is installed as a PWA (required on Android).
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg && reg.showNotification) {
      await reg.showNotification(title, options);
      return;
    }
  } catch { /* fall through to the plain API */ }
  if (permission() === 'granted') new Notification(title, options);
}

/* ---------- the reminder loop ---------- */

function reminderKey(task) {
  return `${task.id}@${task.reminderAt}`;
}

function check() {
  if (permission() !== 'granted' || !getTasksRef) return;

  const now = Date.now();
  const notified = db.getNotified();
  let changed = false;

  for (const task of getTasksRef()) {
    if (task.completed || !task.reminderAt) continue;
    const at = Date.parse(task.reminderAt);
    if (Number.isNaN(at) || at > now || now - at > MAX_AGE_MS) continue;

    const key = reminderKey(task);
    if (notified.includes(key)) continue;

    const due = dueDateTime(task);
    const when = due
      ? `Due ${due.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
      : 'You set a reminder for this task';
    show(task.title, when, key);
    notified.push(key);
    changed = true;
  }

  if (changed) db.setNotified(notified);
}

/**
 * Starts the reminder loop.
 * @param {() => Array} getTasks  callback returning the current task list
 */
export function init(getTasks) {
  getTasksRef = getTasks;
  setInterval(check, CHECK_INTERVAL_MS);
  // Also check immediately and whenever the app returns to the foreground.
  check();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}
