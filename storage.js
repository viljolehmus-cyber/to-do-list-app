/* ==========================================================================
   storage.js — the only module that talks to localStorage.

   Everything is stored locally on the device; there is no backend and no
   sync. The rest of the app goes through this small interface so the
   persistence layer could later be swapped (e.g. for IndexedDB or a real
   API) without touching UI code.

   Data model for a task:
   {
     id, title, notes,
     category,                // category id or null
     priority,                // 'high' | 'medium' | 'low'
     projectId,               // project id ('inbox' by default)
     dueDate, dueTime,        // 'YYYY-MM-DD' / 'HH:MM' or null
     recurrence,              // null | 'daily' | 'weekly' | 'monthly'
     completed, completedAt,  // boolean / ISO string
     attachments,             // [{ id, name, dataUrl }]  (images as base64)
     reminderAt,              // ISO string or null
     createdAt, updatedAt     // ISO strings
   }
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
    alert('Storage is full — try removing some image attachments.');
  }
}

/** Generates a short unique id. */
export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const nowISO = () => new Date().toISOString();

/* ---------- tasks ---------- */

export function getTasks() {
  return read(KEYS.tasks, []);
}

export function getTask(id) {
  return getTasks().find((t) => t.id === id) || null;
}

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

export function getProjects() {
  return read(KEYS.projects, []);
}

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

export function getCategories() {
  return read(KEYS.categories, []);
}

export function getCategory(id) {
  return getCategories().find((c) => c.id === id) || null;
}

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
  name: '',          // used in the greeting
  theme: 'system',   // 'light' | 'dark' | 'system'
  seeded: false,
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) };
}

export function saveSettings(patch) {
  write(KEYS.settings, { ...getSettings(), ...patch });
}

/* ---------- notification bookkeeping ---------- */

/** Keys of reminders that already fired, so they only fire once. */
export function getNotified() {
  return read(KEYS.notified, []);
}

export function setNotified(keys) {
  write(KEYS.notified, keys.slice(-200)); // keep the list small
}

/* ---------- import / export / reset ---------- */

export function exportData() {
  return JSON.stringify({
    app: 'taskly',
    version: 1,
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
  write(KEYS.settings, { ...getSettings(), ...(data.settings || {}), seeded: true });
}

export function clearAll() {
  Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
}

/* ---------- first-run sample data ---------- */

/** ISO date string for `today + offset` days. */
function dayOffset(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ISO timestamp `offset` days ago at the given hour (for completedAt). */
function doneAt(offsetDays, hour = 18) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  d.setHours(hour, 12, 0, 0);
  return d.toISOString();
}

/**
 * Seeds the app with colorful sample content on first launch so it feels
 * alive immediately. Runs only once (tracked via settings.seeded).
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

    // Completed over the past days — feeds the stats charts and the streak.
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

  write(KEYS.categories, categories);
  write(KEYS.projects, projects);
  write(KEYS.tasks, tasks);
  saveSettings({ seeded: true });
}
