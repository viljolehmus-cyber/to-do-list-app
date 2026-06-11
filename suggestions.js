/* ==========================================================================
   suggestions.js — rule-based smart suggestions & automations.

   Everything here is deterministic and runs fully offline:
     • suggestCategory()   — guess a category from keywords in the title
     • suggestRecurrence() — detect tasks the user keeps repeating
     • dueInfo helpers     — overdue / due-today / due-soon classification
     • buildToday()        — the "Today" smart view (most relevant tasks)

   A commented hook for a future LLM-powered upgrade is at the bottom.
   ========================================================================== */

/* ---------- date helpers (shared with app.js via exports) ---------- */

/** 'YYYY-MM-DD' for a Date. */
export function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const todayStr = () => toISODate(new Date());

/**
 * Concrete Date for a task's deadline. A task with a date but no time is
 * treated as due at the end of that day (so it isn't "overdue" at 00:01).
 */
export function dueDateTime(task) {
  if (!task.dueDate) return null;
  const [h, m] = task.dueTime ? task.dueTime.split(':').map(Number) : [23, 59];
  const [Y, M, D] = task.dueDate.split('-').map(Number);
  return new Date(Y, M - 1, D, h, m);
}

export function isOverdue(task, now = new Date()) {
  if (task.completed || !task.dueDate) return false;
  const due = dueDateTime(task);
  return due < now && task.dueDate !== toISODate(now);
}

export function isDueToday(task, now = new Date()) {
  return !task.completed && task.dueDate === toISODate(now);
}

/** Due within the next `hours` (but not today and not overdue). */
export function isDueSoon(task, hours = 48, now = new Date()) {
  if (task.completed || !task.dueDate) return false;
  const due = dueDateTime(task);
  return due > now && due - now <= hours * 3600 * 1000 && !isDueToday(task, now);
}

/* ---------- 1. category from keywords ---------- */

/**
 * Keyword rules keyed by *category name* (lowercase), so they keep working
 * for user-created categories with matching names.
 */
const CATEGORY_KEYWORDS = {
  work: ['meeting', 'email', 'report', 'client', 'deadline', 'presentation',
         'project', 'call', 'invoice', 'slides', 'standup', 'review', 'demo',
         'interview', 'boss', 'office'],
  home: ['clean', 'laundry', 'dishes', 'grocer', 'trash', 'plant', 'repair',
         'cook', 'vacuum', 'garden', 'bill', 'rent', 'kitchen', 'fix',
         'declutter', 'organize closet'],
  study: ['study', 'read', 'learn', 'course', 'exam', 'homework', 'lecture',
          'practice', 'chapter', 'revise', 'essay', 'thesis', 'flashcard',
          'tutorial', 'book'],
  health: ['gym', 'run', 'workout', 'doctor', 'dentist', 'meditat', 'yoga',
           'walk', 'medication', 'vitamin', 'sleep', 'stretch', 'swim',
           'therapy', 'checkup'],
  personal: ['birthday', 'gift', 'friend', 'family', 'mom', 'dad', 'movie',
             'journal', 'trip', 'vacation', 'hobby', 'date night', 'photos'],
};

/**
 * Suggests a category for a task title.
 * @param {string} title
 * @param {Array<{id,name,color}>} categories  existing categories
 * @returns the best-matching category object, or null
 */
export function suggestCategory(title, categories) {
  const text = (title || '').toLowerCase();
  if (text.length < 3) return null;

  let best = null;
  let bestScore = 0;
  for (const cat of categories) {
    const keywords = CATEGORY_KEYWORDS[cat.name.toLowerCase()];
    if (!keywords) continue;
    const score = keywords.reduce((n, kw) => n + (text.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return best;
}

/* ---------- 2. recurrence detection ---------- */

const normalize = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();

/**
 * If the user has completed the same task title several times, suggest
 * turning it into a recurring task based on the median gap between
 * completions.
 * @returns 'daily' | 'weekly' | 'monthly' | null
 */
export function suggestRecurrence(title, tasks) {
  const key = normalize(title);
  if (key.length < 4) return null;

  const completions = tasks
    .filter((t) => t.completedAt && normalize(t.title) === key)
    .map((t) => new Date(t.completedAt).getTime())
    .sort((a, b) => a - b);

  if (completions.length < 3) return null;

  const gaps = [];
  for (let i = 1; i < completions.length; i++) {
    gaps.push((completions[i] - completions[i - 1]) / 86400000); // days
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];

  if (median <= 1.5) return 'daily';
  if (median <= 10)  return 'weekly';
  if (median <= 45)  return 'monthly';
  return null;
}

/* ---------- 3. surface urgent tasks ---------- */

export function getOverdueTasks(tasks, now = new Date()) {
  return tasks.filter((t) => isOverdue(t, now));
}

export function getDueSoonTasks(tasks, hours = 48, now = new Date()) {
  return tasks.filter((t) => isDueToday(t, now) || isDueSoon(t, hours, now));
}

/* ---------- 4. the "Today" smart view ---------- */

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

/**
 * Gathers the most relevant tasks for right now:
 *   overdue   — needs attention first
 *   today     — explicitly due today
 *   suggested — due in the next 2 days, or high-priority without a date
 */
export function buildToday(tasks, now = new Date()) {
  const open = tasks.filter((t) => !t.completed);
  const byPriority = (a, b) =>
    (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1);

  const overdue = open.filter((t) => isOverdue(t, now)).sort(byPriority);
  const today   = open.filter((t) => isDueToday(t, now)).sort(byPriority);
  const suggested = open
    .filter((t) => isDueSoon(t, 48, now) || (t.priority === 'high' && !t.dueDate))
    .sort(byPriority)
    .slice(0, 5);

  const doneToday = tasks.filter(
    (t) => t.completed && t.completedAt && toISODate(new Date(t.completedAt)) === toISODate(now)
  );

  return { overdue, today, suggested, doneToday };
}

/* ---------- 5. future: LLM-powered suggestions (optional hook) ----------

   To upgrade the rule-based engine above with a real language model, wire
   this hook into app.js. It must stay optional: the app is offline-first
   and everything has to keep working without it.

   export async function llmSuggestions(task, context) {
     const res = await fetch('https://your-backend.example/suggest', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ title: task.title, notes: task.notes, context }),
     });
     if (!res.ok) return null;
     return res.json(); // e.g. { category, priority, recurrence, subtasks }
   }
------------------------------------------------------------------------- */
