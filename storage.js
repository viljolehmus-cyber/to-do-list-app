/* ==========================================================================
   storage.js — the only module that talks to localStorage.

   Everything is stored locally on this device; there are no accounts, no
   backend and no sync. The rest of the app goes through this small
   interface so the persistence layer could later be swapped without
   touching UI code.

   Task shape:
   { id, title, notes, category, priority, projectId, dueDate, dueTime,
     recurrence, completed, completedAt, attachments, reminderAt,
     createdAt, updatedAt }
   ========================================================================== */

const KEYS = {
  tasks:      'taskly.tasks',
  projects:   'taskly.projects',
  categories: 'taskly.categories',
  settings:   'taskly.settings',
  notified:   'taskly.notified',
};

/* ---------- low-level helpers ---------- */

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Most likely the quota was exceeded (large base64 attachments).
    console.warn('[storage] Could not persist data:', err);
  }
}

/** Generates a short unique id. */
export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const nowISO = () => new Date().toISOString();

/* ---------- tasks ---------- */

export function getTasks() { return read(KEYS.tasks, []); }
export function getTask(id) { return getTasks().find((t) => t.id === id) || null; }

/** Inserts or updates a task. Returns the saved task. */
export function saveTask(task) {
  const tasks = getTasks();
  task.updatedAt = nowISO();
  if (!task.id) task.id = uid();
  if (!task.createdAt) task.createdAt = nowISO();
  const i = tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) tasks[i] = task;
  else tasks.unshift(task);
  write(KEYS.tasks, tasks);
  return task;
}

export function deleteTask(id) {
  write(KEYS.tasks, getTasks().filter((t) => t.id !== id));
}

/* ---------- projects (lists) ---------- */

export function getProjects() { return read(KEYS.projects, []); }

export function saveProject(project) {
  const projects = getProjects();
  if (!project.id) project.id = uid();
  const i = projects.findIndex((p) => p.id === project.id);
  if (i >= 0) projects[i] = project;
  else projects.push(project);
  write(KEYS.projects, projects);
  return project;
}

/** Deletes a project and moves its tasks back to the Inbox. */
export function deleteProject(id) {
  if (id === 'inbox') return; // the Inbox is permanent
  write(KEYS.projects, getProjects().filter((p) => p.id !== id));
  const tasks = getTasks();
  tasks.forEach((t) => { if (t.projectId === id) t.projectId = 'inbox'; });
  write(KEYS.tasks, tasks);
}

/* ---------- categories (tags) ---------- */

export function getCategories() { return read(KEYS.categories, []); }
export function getCategory(id) { return getCategories().find((c) => c.id === id) || null; }

export function saveCategory(category) {
  const categories = getCategories();
  if (!category.id) category.id = uid();
  const i = categories.findIndex((c) => c.id === category.id);
  if (i >= 0) categories[i] = category;
  else categories.push(category);
  write(KEYS.categories, categories);
  return category;
}

/** Deletes a category and clears it from any tasks that used it. */
export function deleteCategory(id) {
  write(KEYS.categories, getCategories().filter((c) => c.id !== id));
  const tasks = getTasks();
  tasks.forEach((t) => { if (t.category === id) t.category = null; });
  write(KEYS.tasks, tasks);
}

/* ---------- settings ---------- */

const DEFAULT_SETTINGS = {
  name: '',               // greeting name (asked once inside the app)
  theme: 'system',        // 'light' | 'dark' | 'system'
  onboardingSeen: false,  // first-run slideshow flag
  namePromptSeen: false,  // the one-time "what's your name?" sheet
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) };
}

export function saveSettings(patch) {
  write(KEYS.settings, { ...getSettings(), ...patch });
}

/* ---------- notification bookkeeping ---------- */

/** Keys of reminders that already fired, so they only fire once. */
export function getNotified() { return read(KEYS.notified, []); }
export function setNotified(keys) { write(KEYS.notified, keys.slice(-200)); }

/* ---------- import / export / reset ---------- */

export function exportData() {
  return JSON.stringify({
    app: 'taskly',
    version: 2,
    exportedAt: nowISO(),
    tasks: getTasks(),
    projects: getProjects(),
    categories: getCategories(),
    settings: getSettings(),
  }, null, 2);
}

/** Replaces all data with a previously exported payload. Throws on bad input. */
export function importData(json) {
  const data = JSON.parse(json);
  if (data.app !== 'taskly' || !Array.isArray(data.tasks)) {
    throw new Error('Not a valid Taskly backup file.');
  }
  write(KEYS.tasks, data.tasks);
  write(KEYS.projects, data.projects || []);
  write(KEYS.categories, data.categories || []);
  write(KEYS.settings, { ...getSettings(), ...(data.settings || {}), onboardingSeen: true });
}

export function clearAll() {
  Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
}

/* ---------- starter content ---------- */

/**
 * The app starts EMPTY (no sample tasks) — it just gets an Inbox and the
 * five colourful starter categories so everything works from the first tap.
 * Idempotent: only fills what's missing.
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
