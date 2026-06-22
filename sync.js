/* ==========================================================================
   sync.js — keeps the local cache (storage.js) and Supabase in step.

   Strategy (offline-first):
     • Reads come from the local cache, so the UI is always instant.
     • Writes apply to the cache immediately and append to a per-user queue
       (in storage.js). This module flushes that queue to Postgres.
     • On login we pull the user's rows into the cache.
     • Offline writes stay queued and flush automatically when back online.
     • Realtime (optional) tells other devices to re-pull on remote changes.

   Each entity is stored as a row { id, user_id, data, updated_at }; settings
   is a single row keyed by user_id. RLS (see SETUP.md) scopes every row to
   its owner — the client never has to (and must not) be trusted for that.
   ========================================================================== */

import { sb } from './supa.js';
import * as db from './storage.js';

const LIST_TABLES = ['tasks', 'projects', 'categories'];

let userId = null;
let onStatus = () => {};
let onRemote = () => {};
let channel = null;
let flushing = false;
let queuedWhileFlushing = false;
let bound = false;

export function setUser(id) { userId = id || null; }

/** Wire up listeners. Safe to call again on re-login. */
export function start({ status = () => {}, remoteChange = () => {} } = {}) {
  onStatus = status;
  onRemote = remoteChange;
  db.onFlush(flush);                 // storage.js calls this after each write
  if (!bound) {                      // window listeners only need binding once
    window.addEventListener('online', () => { emit(); flush(); }, { passive: true });
    window.addEventListener('offline', () => emit('offline'), { passive: true });
    bound = true;
  }
  subscribeRealtime();
  emit();
}

export function stop() {
  if (channel) { try { sb.removeChannel(channel); } catch {} channel = null; }
  db.onFlush(null);
}

function emit(forced) {
  if (forced) return onStatus(forced);
  if (!navigator.onLine) return onStatus('offline');
  onStatus(db.getQueue().length ? 'syncing' : 'synced');
}

/* ---------- row mapping ---------- */

function toRow(table, op) {
  if (table === 'settings') {
    return { user_id: userId, data: op.row, updated_at: new Date().toISOString() };
  }
  return { id: op.id, user_id: userId, data: op.row, updated_at: op.row?.updatedAt || new Date().toISOString() };
}

/* ---------- pull ---------- */

/** Fetch everything for the current user and replace the local cache. */
export async function pull() {
  if (!sb || !userId) return;
  onStatus('syncing');
  const [tasks, projects, categories, settings] = await Promise.all([
    sb.from('tasks').select('data').eq('user_id', userId),
    sb.from('projects').select('data').eq('user_id', userId),
    sb.from('categories').select('data').eq('user_id', userId),
    sb.from('settings').select('data').eq('user_id', userId).maybeSingle(),
  ]);
  const firstError = tasks.error || projects.error || categories.error || settings.error;
  if (firstError) { onStatus('error'); throw firstError; }

  db.hydrate({
    tasks: (tasks.data || []).map((r) => r.data),
    projects: (projects.data || []).map((r) => r.data),
    categories: (categories.data || []).map((r) => r.data),
    settings: settings.data ? settings.data.data : {},
  });
  emit();
}

/* ---------- flush ---------- */

/** Push queued local writes to the cloud. Safe to call often. */
export async function flush() {
  if (!sb || !userId) return;
  if (!navigator.onLine) { emit('offline'); return; }
  if (flushing) { queuedWhileFlushing = true; return; }

  let queue = db.getQueue();
  if (!queue.length) { emit('synced'); return; }

  flushing = true;
  onStatus('syncing');
  try {
    // collapse to the latest op per (table,id) to minimise round-trips
    const latest = new Map();
    for (const op of queue) latest.set(`${op.table}/${op.id}`, op);
    const ops = [...latest.values()];

    for (const table of [...LIST_TABLES, 'settings']) {
      const upserts = ops.filter((o) => o.table === table && o.type === 'upsert');
      if (upserts.length) {
        const rows = upserts.map((o) => toRow(table, o));
        const onConflict = table === 'settings' ? 'user_id' : 'user_id,id';
        const { error } = await sb.from(table).upsert(rows, { onConflict });
        if (error) throw error;
      }
      const deletes = ops.filter((o) => o.table === table && o.type === 'delete');
      for (const d of deletes) {
        const { error } = await sb.from(table).delete().eq('user_id', userId).eq('id', d.id);
        if (error) throw error;
      }
    }

    // Drop exactly what we sent; anything queued meanwhile stays.
    const sentKeys = new Set(ops.map((o) => `${o.table}/${o.id}/${o.ts}`));
    db.setQueue(db.getQueue().filter((o) => !sentKeys.has(`${o.table}/${o.id}/${o.ts}`)));
    emit();
  } catch (err) {
    console.warn('[sync] flush failed:', err?.message || err);
    onStatus(navigator.onLine ? 'error' : 'offline');
  } finally {
    flushing = false;
    if (queuedWhileFlushing) { queuedWhileFlushing = false; flush(); }
  }
}

/* ---------- realtime (optional live sync across devices) ---------- */

function subscribeRealtime() {
  if (!sb || !userId || channel) return;
  try {
    channel = sb.channel(`taskly:${userId}`);
    for (const table of LIST_TABLES) {
      channel.on('postgres_changes',
        { event: '*', schema: 'public', table, filter: `user_id=eq.${userId}` },
        () => { if (!flushing && !db.getQueue().length) onRemote(); });
    }
    channel.subscribe();
  } catch (err) {
    console.warn('[sync] realtime unavailable:', err?.message || err);
  }
}
