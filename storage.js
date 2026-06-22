/* ==========================================================================
   storage.js — the local cache and the app's synchronous data interface.

   The UI reads from here (synchronously, as it always has). In CLOUD mode
   this cache is hydrated from Supabase on login and every write also records
   an op in a per-user sync queue that sync.js flushes to Postgres — that's
   what makes the app offline-first: writes apply instantly (optimistic) and
   reconcile with the cloud when possible. In LOCAL mode (Supabase not
   configured) this is simply the source of truth, on this device.

   Everything is namespaced per user via setScope(userId), so multiple
   accounts on one device never see each other's data.

   Task shape:
   { id, title, notes, category, priority, projectId, dueDate, dueTime,
     recurrence, completed, completedAt, attachments, reminderAt,
     createdAt, updatedAt }
   ========================================================================== */

const PREFIX = 'taskly';
let scope = null; // current user/account id; null = logged out

/** All cloud-synced collections (settings is a single object, not a list). */
const TABLES = ['tasks', 'projects', 'categories', 'settings'];

const nowISO = () => new Date().toISOString();

/** Generates a short unique id (used for tasks/projects/categories). */
export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- scope & low-level storage ---------- */

const key = (name) => `${PREFIX}.u.${scope}.${name}`;

/** Point the cache at a given user. Pass null on logout. */
export function setScope(id) { scope = id || null; }
export function getScope() { return scope; }

function read(name, fallback) {
  if (!scope) return fallback;
  try {
    const raw = localStorage.getItem(key(name));
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function write(name, value) {
  if (!scope) return;
  try {
    localStorage.setItem(key(name), JSON.stringify(value));
  } catch (err) {
    console.warn('[storage] could not persist (quota?):', err);
  }
}

/* ---------- sync queue (consumed by sync.js in cloud mode) ---------- */

let flushFn = null;
let flushTimer = null;

/** sync.js registers its flush function here. No-op in local mode. */
export function onFlush(fn) { flushFn = fn; }
export function getQueue() { return read('queue', []); }
export function setQueue(q) { write('queue', q); }

function enqueue(table, op) {
  if (!scope) return;
  const q = read('queue', []);
  q.push({ table, ...op, ts: Date.now() });
  write('queue', q);
  scheduleFlush();
}

function scheduleFlush() {
  if (!flushFn) return;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flushFn(); }, 350);
}

/** Force a flush attempt now (e.g. when coming back online). */
export function requestSync() { if (flushFn) flushFn(); }

/* ---------- tasks ---------- */

export function getTasks() { return read('tasks', []); }
export function getTask(id) { return getTasks().find((t) => t.id === id) || null; }

export function saveTask(task) {
  const tasks = getTasks();
  task.updatedAt = nowISO();
  if (!task.id) task.id = uid();
  if (!task.createdAt) task.createdAt = nowISO();
  const i = tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) tasks[i] = task; else tasks.unshift(task);
  write('tasks', tasks);
  enqueue('tasks', { type: 'upsert', id: task.id, row: task });
  return task;
}

export function deleteTask(id) {
  write('tasks', getTasks().filter((t) => t.id !== id));
  enqueue('tasks', { type: 'delete', id });
}

/* ---------- projects (lists) ---------- */

export function getProjects() { return read('projects', []); }

export function saveProject(project) {
  const projects = getProjects();
  if (!project.id) project.id = uid();
  const i = projects.findIndex((p) => p.id === project.id);
  if (i >= 0) projects[i] = project; else projects.push(project);
  write('projects', projects);
  enqueue('projects', { type: 'upsert', id: project.id, row: project });
  return project;
}

/** Deletes a project and moves its tasks back to the Inbox. */
export function deleteProject(id) {
  if (id === 'inbox') return; // the Inbox is permanent
  write('projects', getProjects().filter((p) => p.id !== id));
  enqueue('projects', { type: 'delete', id });
  const tasks = getTasks();
  let changed = false;
  tasks.forEach((t) => {
    if (t.projectId === id) {
      t.projectId = 'inbox';
      t.updatedAt = nowISO();
      enqueue('tasks', { type: 'upsert', id: t.id, row: t });
      changed = true;
    }
  });
  if (changed) write('tasks', tasks);
}

/* ---------- categories (tags) ---------- */

export function getCategories() { return read('categories', []); }
export function getCategory(id) { return getCategories().find((c) => c.id === id) || null; }

export function saveCategory(category) {
  const categories = getCategories();
  if (!category.id) category.id = uid();
  const i = categories.findIndex((c) => c.id === category.id);
  if (i >= 0) categories[i] = category; else categories.push(category);
  write('categories', categories);
  enqueue('categories', { type: 'upsert', id: category.id, row: category });
  return category;
}

/** Deletes a category and clears it from any tasks that used it. */
export function deleteCategory(id) {
  write('categories', getCategories().filter((c) => c.id !== id));
  enqueue('categories', { type: 'delete', id });
  const tasks = getTasks();
  let changed = false;
  tasks.forEach((t) => {
    if (t.category === id) {
      t.category = null;
      t.updatedAt = nowISO();
      enqueue('tasks', { type: 'upsert', id: t.id, row: t });
      changed = true;
    }
  });
  if (changed) write('tasks', tasks);
}

/* ---------- settings (single object per user) ---------- */

const DEFAULT_SETTINGS = {
  name: '',              // greeting name
  theme: 'system',       // 'light' | 'dark' | 'system'
  onboardingSeen: false, // per-account onboarding flag
  seeded: false,         // local-mode sample-data guard
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read('settings', {}) };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  write('settings', next);
  enqueue('settings', { type: 'upsert', id: scope, row: next });
  return next;
}

/* ---------- notification bookkeeping (device-local, not synced) ---------- */

export function getNotified() {
  try { return JSON.parse(localStorage.getItem(`${PREFIX}.notified`)) || []; }
  catch { return []; }
}
export function setNotified(keys) {
  localStorage.setItem(`${PREFIX}.notified`, JSON.stringify(keys.slice(-200)));
}

/* ---------- cloud hydration ---------- */

/**
 * Replace the cache with data pulled from the cloud. Called by sync.js
 * after a successful pull (when there are no pending local writes).
 */
export function hydrate({ tasks, projects, categories, settings }) {
  if (!scope) return;
  write('tasks', tasks || []);
  write('projects', projects || []);
  write('categories', categories || []);
  write('settings', settings || {});
  write('queue', []); // cloud is now the source of truth
}

/* ---------- import / export / reset ---------- */

export function exportData() {
  return JSON.stringify({
    app: 'taskly', version: 2, exportedAt: nowISO(),
    tasks: getTasks(), projects: getProjects(),
    categories: getCategories(), settings: getSettings(),
  }, null, 2);
}

/** Replaces all data with a previously exported payload (and queues a sync). */
export function importData(json) {
  const data = JSON.parse(json);
  if (data.app !== 'taskly' || !Array.isArray(data.tasks)) {
    throw new Error('Not a valid Taskly backup file.');
  }
  write('tasks', data.tasks);
  write('projects', data.projects || []);
  write('categories', data.categories || []);
  write('settings', { ...getSettings(), ...(data.settings || {}) });
  // queue everything so it reaches the cloud
  data.tasks.forEach((t) => enqueue('tasks', { type: 'upsert', id: t.id, row: t }));
  (data.projects || []).forEach((p) => enqueue('projects', { type: 'upsert', id: p.id, row: p }));
  (data.categories || []).forEach((c) => enqueue('categories', { type: 'upsert', id: c.id, row: c }));
  enqueue('settings', { type: 'upsert', id: scope, row: getSettings() });
}

/** Wipes the current user's local cache (used on account deletion). */
export function clearAll() {
  if (!scope) return;
  [...TABLES, 'queue'].forEach((n) => localStorage.removeItem(key(n)));
}

/* ---------- starter content ---------- */

/**
 * Gives a brand-new account an Inbox and the five colourful starter
 * categories so the app looks alive and tasks have somewhere to live.
 * Idempotent — only fills what's missing. Runs for every new user
 * (cloud or local); the rows it creates sync to the cloud.
 */
export function ensureDefaults() {
  if (getProjects().length === 0) {
    saveProject({ id: 'inbox', name: 'Inbox', color: 'blue' });
  }
  if (getCategories().length === 0) {
    [['Work', 'blue'], ['Home', 'orange'], ['Study', 'purple'],
     ['Health', 'mint'], ['Personal', 'pink']]
      .forEach(([name, color]) => saveCategory({ name, color }));
  }
}

/* ---------- first-run sample data (LOCAL mode only) ---------- */

function dayOffset(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function doneAt(offsetDays, hour = 18) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  d.setHours(hour, 12, 0, 0);
  return d.toISOString();
}

/**
 * Seeds colourful sample tasks so a local-mode account feels alive on first
 * launch. Cloud accounts intentionally start empty (real data only) — they
 * get ensureDefaults() instead. Runs once per local account.
 */
export function ensureSeed() {
  if (getSettings().seeded) return;

  const categories = [
    { id: 'cat-work',     name: 'Work',     color: 'blue'   },
    { id: 'cat-home',     name: 'Home',     color: 'orange' },
    { id: 'cat-study',    name: 'Study',    color: 'purple' },
    { id: 'cat-health',   name: 'Health',   color: 'mint'   },
    { id: 'cat-personal', name: 'Personal', color: 'pink'   },
  ];
  const projects = [
    { id: 'inbox',       name: 'Inbox',          color: 'blue'   },
    { id: 'proj-launch', name: 'Website launch', color: 'purple' },
    { id: 'proj-home',   name: 'Home refresh',   color: 'orange' },
  ];

  const t = (data) => ({
    id: uid(), title: '', notes: '', category: null, priority: 'medium',
    projectId: 'inbox', dueDate: null, dueTime: null, recurrence: null,
    completed: false, completedAt: null, attachments: [], reminderAt: null,
    createdAt: nowISO(), updatedAt: nowISO(), ...data,
  });

  const tasks = [
    t({ title: 'Finish landing page hero section', category: 'cat-work', priority: 'high',
        projectId: 'proj-launch', dueDate: dayOffset(0),
        notes: 'Big bold headline, gradient background, primary CTA above the fold.' }),
    t({ title: 'Review pull requests', category: 'cat-work', priority: 'medium',
        projectId: 'proj-launch', dueDate: dayOffset(1) }),
    t({ title: 'Water the plants', category: 'cat-home', priority: 'low',
        recurrence: 'daily', dueDate: dayOffset(0) }),
    t({ title: 'Pay electricity bill', category: 'cat-home', priority: 'high',
        projectId: 'proj-home', dueDate: dayOffset(2), dueTime: '17:00' }),
    t({ title: 'Book dentist appointment', category: 'cat-health', priority: 'high',
        dueDate: dayOffset(-2), notes: 'Ask about the Saturday slots.' }),
    t({ title: 'Read 20 pages of Atomic Habits', category: 'cat-study', priority: 'medium',
        dueDate: dayOffset(0) }),
    t({ title: 'Plan weekend trip', category: 'cat-personal', priority: 'low',
        notes: 'Shortlist: coast, mountains, or a city break?' }),
    t({ title: 'Prepare slides for client demo', category: 'cat-work', priority: 'medium',
        projectId: 'proj-launch', dueDate: dayOffset(3) }),
    t({ title: 'Team standup notes', category: 'cat-work', priority: 'medium',
        dueDate: dayOffset(0), completed: true, completedAt: doneAt(0, 10) }),
    t({ title: '30-minute run', category: 'cat-health', priority: 'medium',
        completed: true, completedAt: doneAt(1) }),
    t({ title: 'Read 20 pages of Atomic Habits', category: 'cat-study', priority: 'medium',
        completed: true, completedAt: doneAt(1, 21) }),
    t({ title: 'Buy groceries', category: 'cat-home', priority: 'medium',
        completed: true, completedAt: doneAt(2) }),
    t({ title: 'Read 20 pages of Atomic Habits', category: 'cat-study', priority: 'medium',
        completed: true, completedAt: doneAt(2, 21) }),
    t({ title: 'Workout session', category: 'cat-health', priority: 'medium',
        completed: true, completedAt: doneAt(3) }),
    t({ title: 'Read 20 pages of Atomic Habits', category: 'cat-study', priority: 'medium',
        completed: true, completedAt: doneAt(3, 21) }),
    t({ title: 'Submit expense report', category: 'cat-work', priority: 'low',
        completed: true, completedAt: doneAt(4) }),
  ];

  write('categories', categories);
  write('projects', projects);
  write('tasks', tasks);
  saveSettings({ seeded: true });
}
