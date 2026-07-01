/* ==========================================================================
   app.js — Taskly main controller.

   Owns UI state, renders the four tabs (Today / Tasks / Stats / Profile),
   and wires up bottom sheets, the FAB, toasts with undo, charts and theme
   switching. All persistence goes through storage.js; all "smart" logic
   lives in suggestions.js.

   PERFORMANCE NOTES
   - Lists are never rebuilt wholesale after the first paint: a keyed
     reconciler (reconcileTaskList) adds/removes/reorders only the rows
     that changed, and withFlip() animates position deltas with
     transforms (FLIP), so rows glide instead of jumping.
   - Only transform/opacity are animated (CSS + Web Animations API).
   - DOM reads and writes are batched: FLIP reads all rects, then
     mutates, then reads again, then starts animations. Drag handlers
     write styles inside requestAnimationFrame.
   - will-change is applied only while a row/sheet is actively dragged.
   - Scroll-blocking is avoided via CSS touch-action (pan-y on rows,
     none on sheet grips) instead of non-passive touch listeners; the
     only scroll-adjacent listener (resize) is passive.
   - prefers-reduced-motion disables FLIP/WAAPI/counters here, and CSS
     collapses its own animations.
   ========================================================================== */

import { icon } from './icons.js';
import * as db from './storage.js';
import * as smart from './suggestions.js';
import * as notify from './notifications.js';
import * as entry from './entry.js';

/* ==========================================================================
   Constants & small helpers
   ========================================================================== */

const COLOR_HEX = {
  blue: '#5B6CFF', pink: '#FF4D8D', mint: '#19C68C',
  orange: '#FF9D42', purple: '#9D6BFF', red: '#FF5A5F', yellow: '#FFC940',
};
const COLOR_NAMES = Object.keys(COLOR_HEX);
const CHART_PALETTE = ['#5B6CFF', '#FF4D8D', '#19C68C', '#FF9D42', '#9D6BFF', '#FFC940', '#FF5A5F'];

const PRIORITY = {
  high:   { label: 'High',   cls: 'c-red'    },
  medium: { label: 'Medium', cls: 'c-orange' },
  low:    { label: 'Low',    cls: 'c-mint'   },
};

const RECURRENCE_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape user-provided text before interpolating into HTML. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------- motion language (shared with styles.css tokens) ---------- */

const EASE_OUT = 'cubic-bezier(.22, 1, .36, 1)';
const EASE_SPRING = 'cubic-bezier(.34, 1.56, .64, 1)';
const rmQuery = matchMedia('(prefers-reduced-motion: reduce)');
const reducedMotion = () => rmQuery.matches;

/**
 * FLIP: measure First positions, mutate the DOM, measure Last positions,
 * then animate each surviving row by its delta using only transforms.
 * Reads and writes are strictly batched (read-all → mutate → read-all →
 * animate-all), never interleaved.
 */
function withFlip(scope, mutate) {
  if (reducedMotion()) { mutate(); return; }
  const before = new Map();
  for (const el of $$('.task-item', scope)) before.set(el, el.getBoundingClientRect());
  mutate();
  const moves = [];
  for (const el of $$('.task-item', scope)) {
    const f = before.get(el);
    if (!f) continue; // brand-new row: it has its own CSS entrance
    const l = el.getBoundingClientRect();
    if (!l.height) continue; // inside a hidden section
    const dy = f.top - l.top;
    if (Math.abs(dy) > 2) moves.push([el, dy]);
  }
  for (const [el, dy] of moves) {
    el.animate(
      [{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
      { duration: 340, easing: EASE_OUT },
    );
  }
}

/* ---------- date formatting ---------- */

function parseISODate(iso) {
  const [Y, M, D] = iso.split('-').map(Number);
  return new Date(Y, M - 1, D);
}

function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Friendly label for a due date: Today / Tomorrow / Yesterday / Wed, Jun 18 */
function fmtDueLabel(task) {
  if (!task.dueDate) return '';
  const today = parseISODate(smart.todayStr());
  const due = parseISODate(task.dueDate);
  const diff = Math.round((due - today) / 86400000);
  let label;
  if (diff === 0) label = 'Today';
  else if (diff === 1) label = 'Tomorrow';
  else if (diff === -1) label = 'Yesterday';
  else label = due.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  if (task.dueTime) label += ` · ${fmtTime(task.dueTime)}`;
  return label;
}

/** Advance a YYYY-MM-DD date by one recurrence interval. */
function advanceDate(iso, recurrence) {
  const d = parseISODate(iso);
  if (recurrence === 'daily') d.setDate(d.getDate() + 1);
  else if (recurrence === 'weekly') d.setDate(d.getDate() + 7);
  else if (recurrence === 'monthly') {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  }
  return smart.toISODate(d);
}

/* ==========================================================================
   Theme
   ========================================================================== */

function applyTheme() {
  const pref = db.getSettings().theme;
  const dark = pref === 'dark' ||
    (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0E0E13' : '#F4F4F7');
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (db.getSettings().theme === 'system') applyTheme();
});

/* ==========================================================================
   UI state
   ========================================================================== */

const state = {
  tab: 'today',                 // 'today' | 'tasks' | 'stats' | 'profile'
  search: '',
  projectId: null,              // null = all lists
  showCompleted: false,
  filters: { status: 'all', category: null, priority: null, due: 'any' },
  refresh: null,                // current view's targeted-update function
};

function activeFilterCount() {
  const f = state.filters;
  return (f.status !== 'all') + (f.category !== null) + (f.priority !== null) + (f.due !== 'any');
}

/** Targeted update of the current view; falls back to a full render. */
function refreshUI() {
  if (state.refresh) state.refresh();
  else render();
}

/* ==========================================================================
   Root render, tab bar & view transitions
   ========================================================================== */

const TABS = [
  { id: 'today',   label: 'Today',   icon: 'sun'   },
  { id: 'tasks',   label: 'Tasks',   icon: 'list'  },
  { id: 'stats',   label: 'Stats',   icon: 'chart' },
  { id: 'profile', label: 'Profile', icon: 'user'  },
];
const TAB_INDEX = Object.fromEntries(TABS.map((t, i) => [t.id, i]));

function render() {
  state.refresh = null;
  const view = $('#view');
  view.className = 'view';
  if (state.tab === 'today') renderToday(view);
  else if (state.tab === 'tasks') renderTasks(view);
  else if (state.tab === 'stats') renderStats(view);
  else renderProfile(view);
}

/** Built once at boot; afterwards only classes and the glider change. */
function buildTabbar() {
  const bar = $('#tabbar');
  bar.innerHTML = `<span class="tab-glider" id="tab-glider"></span>` + TABS.map((t) => `
    <button class="tab ${state.tab === t.id ? 'active' : ''}" data-tab="${t.id}">
      <span class="ind">${icon(t.icon, { size: 22 })}</span>${t.label}
    </button>`).join('');
  $$('.tab', bar).forEach((b) =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));
}

/** Slides the active pill under the current tab (transform only). */
function positionGlider(animate = true) {
  const glider = $('#tab-glider');
  const tab = $(`.tab[data-tab="${state.tab}"]`);
  const ind = $('.ind', tab || document.body);
  if (!glider || !tab || !ind) return;
  const x = tab.offsetLeft + ind.offsetLeft; // batched reads…
  const y = tab.offsetTop + ind.offsetTop;
  if (!animate) glider.style.transition = 'none';
  glider.style.transform = `translate(${x}px, ${y}px)`; // …then writes
  if (!animate) {
    void glider.offsetWidth; // flush so the next move transitions again
    glider.style.transition = '';
  }
}

function setActiveTab(id, animate = true) {
  $$('#tabbar .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
  positionGlider(animate && !reducedMotion());
  if (animate && !reducedMotion()) {
    $(`.tab[data-tab="${id}"] .ind`)?.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.22)' }, { transform: 'scale(1)' }],
      { duration: 340, easing: EASE_SPRING },
    );
  }
}

let viewAnim = null; // kept for cancelled in-flight animations

/** Tab switches are instant: the new view is fully rendered and visible
    in the same frame as the tap — no entrance animation on content. */
function switchTab(next) {
  if (next === state.tab) { render(); return; }
  state.tab = next;
  setActiveTab(next);
  viewAnim?.cancel();
  viewAnim = null;
  render();
  window.scrollTo(0, 0);
}

/* ==========================================================================
   Task row component (+ keyed reconciler)
   ========================================================================== */

function categoryOf(task) {
  return task.category ? db.getCategory(task.category) : null;
}

function taskItemInner(task) {
  const cat = categoryOf(task);
  const checkColor = cat ? COLOR_HEX[cat.color] : '';
  const chips = [];

  if (task.dueDate) {
    const overdue = smart.isOverdue(task);
    const today = smart.isDueToday(task);
    chips.push(`<span class="meta-chip ${overdue ? 'overdue' : today ? 'c-blue' : ''}">
      ${icon('calendar', { size: 12 })}${overdue ? 'Overdue · ' : ''}${esc(fmtDueLabel(task))}</span>`);
  }
  if (cat) {
    chips.push(`<span class="meta-chip c-${cat.color}"><span class="dot c-${cat.color}"></span>${esc(cat.name)}</span>`);
  }
  if (task.priority && PRIORITY[task.priority]) {
    chips.push(`<span class="meta-chip ${PRIORITY[task.priority].cls}">${icon('flag', { size: 12 })}${PRIORITY[task.priority].label}</span>`);
  }
  if (task.recurrence) {
    chips.push(`<span class="meta-chip c-purple">${icon('repeat', { size: 12 })}${RECURRENCE_LABEL[task.recurrence]}</span>`);
  }
  if (task.attachments?.length) {
    chips.push(`<span class="meta-chip">${icon('paperclip', { size: 12 })}${task.attachments.length}</span>`);
  }

  return `
    <div class="swipe-action">${icon('trash', { size: 20 })}</div>
    <div class="task-row ${task.completed ? 'done' : ''}"
         ${checkColor ? `style="--check-c:${checkColor}"` : ''} role="button" tabindex="0">
      <button class="check ${task.completed ? 'checked' : ''}" aria-label="Toggle complete">
        ${icon('check', { size: 15, strokeWidth: 3 })}</button>
      <div class="task-main">
        <div class="task-title">${esc(task.title)}</div>
        ${chips.length ? `<div class="task-meta">${chips.join('')}</div>` : ''}
      </div>
      ${icon('chevron-right', { size: 19, cls: 'chevron' })}
    </div>`;
}

function taskItemHTML(task) {
  return `<div class="task-item" data-id="${task.id}" data-u="${esc(task.updatedAt)}">${taskItemInner(task)}</div>`;
}

function createTaskItem(task) {
  const tpl = document.createElement('template');
  tpl.innerHTML = taskItemHTML(task).trim();
  return tpl.content.firstElementChild;
}

/** Wire up check / open / swipe for one .task-item. */
function bindTaskItem(item, opts = {}) {
  const { swipe = true, beforeOpen = null } = opts;
  const row = $('.task-row', item);
  $('.check', row).addEventListener('click', (e) => {
    e.stopPropagation();
    if (item.dataset.noClick) return;
    if (beforeOpen) { beforeOpen(); toggleComplete(item.dataset.id, null); }
    else toggleComplete(item.dataset.id, item);
  });
  row.addEventListener('click', () => {
    if (item.dataset.noClick) return; // a swipe just ended here
    beforeOpen?.();
    openDetailSheet(item.dataset.id);
  });
  if (swipe) attachSwipe(item);
}

function bindList(container, opts = {}) {
  $$('.task-item', container).forEach((el) => bindTaskItem(el, opts));
}

/**
 * Keyed list diff: removes stale rows, inserts new ones (with their CSS
 * entrance), refreshes rows whose task changed (data-u = updatedAt) and
 * reorders in place. Callers wrap it in withFlip() for the glide.
 */
function reconcileTaskList(container, tasks, opts = {}) {
  const existing = new Map();
  for (const el of [...container.children]) {
    if (el.classList.contains('task-item')) existing.set(el.dataset.id, el);
  }
  const wanted = new Set(tasks.map((t) => t.id));
  for (const [id, el] of existing) {
    if (!wanted.has(id)) { el.remove(); existing.delete(id); }
  }
  let cursor = container.firstElementChild;
  for (const task of tasks) {
    let el = existing.get(task.id);
    if (!el) {
      el = createTaskItem(task);
      el.classList.add('row-enter'); // slides in from the top
      bindTaskItem(el, opts);
    } else if (el.dataset.u !== task.updatedAt) {
      el.innerHTML = taskItemInner(task);
      el.dataset.u = task.updatedAt;
      bindTaskItem(el, opts);
    }
    if (el === cursor) cursor = cursor.nextElementSibling;
    else container.insertBefore(el, cursor);
  }
}

/* ==========================================================================
   Swipe-to-delete (follows the finger; transform-only)
   ========================================================================== */

function attachSwipe(item) {
  const row = $('.task-row', item);
  const action = $('.swipe-action', item);
  let pid = null;
  let startX = 0, startY = 0, dx = 0, width = 0;
  let dragging = false, raf = 0;

  row.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    pid = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    dragging = false;
  });

  row.addEventListener('pointermove', (e) => {
    if (pid === null || e.pointerId !== pid) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;

    if (!dragging) {
      if (mx < -10 && Math.abs(mx) > Math.abs(my) * 1.3) {
        dragging = true;
        width = row.offsetWidth; // single layout read at drag start
        row.setPointerCapture(pid);
        row.classList.add('swiping');
        row.style.willChange = 'transform'; // only while actively dragging
      } else if (Math.abs(my) > 12) {
        pid = null; // vertical intent: let native scroll win
        return;
      }
    }
    if (!dragging) return;

    dx = Math.min(0, mx);
    if (!raf) { // batch style writes into one frame
      raf = requestAnimationFrame(() => {
        raf = 0;
        row.style.transform = `translateX(${dx}px)`;
        action.style.opacity = String(Math.min(1, -dx / 90));
      });
    }
  });

  const end = (e) => {
    if (pid === null || e.pointerId !== pid) return;
    pid = null;
    if (!dragging) return;
    dragging = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    row.style.willChange = '';

    // swallow the click this gesture would otherwise fire
    item.dataset.noClick = '1';
    setTimeout(() => delete item.dataset.noClick, 350);

    if (dx < -width * 0.42) {
      // committed: glide the row off, then delete (with undo)
      const out = row.animate(
        [{ transform: `translateX(${dx}px)` }, { transform: `translateX(${-width - 40}px)` }],
        { duration: 170, easing: 'ease-in', fill: 'forwards' },
      );
      out.onfinish = () => deleteTaskWithUndo(item.dataset.id);
    } else {
      // spring back
      row.classList.remove('swiping');
      row.style.transform = '';
      action.style.opacity = '';
      if (!reducedMotion()) {
        row.animate(
          [{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }],
          { duration: 300, easing: EASE_OUT },
        );
      }
    }
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', end);
}

/* ==========================================================================
   Actions: complete / delete / recurrence
   ========================================================================== */

/** Creates the follow-up occurrence for a completed recurring task. */
function createNextOccurrence(task) {
  const base = task.dueDate && task.dueDate > smart.todayStr() ? task.dueDate : smart.todayStr();
  const nextDue = advanceDate(base, task.recurrence);

  // keep the same reminder lead time relative to the new due date
  let reminderAt = null;
  if (task.reminderAt && task.dueDate) {
    const offset = smart.dueDateTime(task) - new Date(task.reminderAt);
    const nextDueDT = smart.dueDateTime({ ...task, dueDate: nextDue });
    reminderAt = new Date(nextDueDT - offset).toISOString();
  }

  return {
    ...task,
    id: db.uid(),
    dueDate: nextDue,
    reminderAt,
    completed: false,
    completedAt: null,
    createdAt: new Date().toISOString(),
  };
}

function toggleComplete(id, itemEl) {
  const task = db.getTask(id);
  if (!task) return;

  if (task.completed) {
    task.completed = false;
    task.completedAt = null;
    db.saveTask(task);
    refreshUI();
    return;
  }

  const finish = () => {
    task.completed = true;
    task.completedAt = new Date().toISOString();
    db.saveTask(task);

    // automation: recurring tasks immediately spawn their next occurrence
    let next = null;
    if (task.recurrence) {
      next = createNextOccurrence(task);
      db.saveTask(next);
    }
    refreshUI();
    showToast(
      next ? `Done! Next one ${fmtDueLabel(next).toLowerCase()}` : 'Task completed',
      {
        undo: () => {
          task.completed = false;
          task.completedAt = null;
          db.saveTask(task);
          if (next) db.deleteTask(next.id);
          refreshUI();
        },
      },
    );
  };

  if (itemEl && !reducedMotion()) {
    // 1. checkmark draws itself + strike-through + brief tinted highlight
    const row = $('.task-row', itemEl);
    $('.check', row).classList.add('checked');
    row.classList.add('done', 'flash');
    // 2. then the row fades/scales out and FLIP glides the list closed
    setTimeout(() => {
      const exit = itemEl.animate(
        [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94) translateY(-4px)' }],
        { duration: 200, easing: 'ease-in', fill: 'forwards' },
      );
      exit.onfinish = finish;
    }, 620);
  } else {
    finish();
  }
}

function deleteTaskWithUndo(id) {
  const copy = db.getTask(id);
  if (!copy) return;
  db.deleteTask(id);
  refreshUI();
  showToast('Task deleted', {
    undo: () => { db.saveTask(copy); refreshUI(); },
  });
}

/* ==========================================================================
   Toast (slides in, pauses, slides out — with undo)
   ========================================================================== */

let toastTimer = null;

function showToast(message, { undo, duration = 5000 } = {}) {
  const toast = $('#toast');
  toast.innerHTML = `
    <span class="msg">${esc(message)}</span>
    ${undo ? `<button class="undo">UNDO</button>` : ''}`;
  if (undo) {
    $('.undo', toast).addEventListener('click', () => {
      hideToast();
      undo();
    });
  }
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').classList.remove('show');
}

/* ==========================================================================
   Bottom sheets — slide up, backdrop fade, drag-to-dismiss
   ========================================================================== */

function openSheet(html) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `<div class="sheet-grip"><div class="sheet-handle"></div></div>${html}`;
  document.body.append(backdrop, sheet);
  requestAnimationFrame(() => {
    backdrop.classList.add('show');
    sheet.classList.add('show');
  });

  let closed = false;
  /** @param {number|null} fromY  current drag offset when dismissed by drag */
  const close = (fromY = null) => {
    if (closed) return;
    closed = true;
    backdrop.classList.remove('dragging', 'show');
    backdrop.style.opacity = '';
    if (fromY !== null && !reducedMotion()) {
      // finish the slide from wherever the finger let go
      sheet.classList.add('dragging'); // transition off; WAAPI takes over
      const travel = sheet.offsetHeight + 60;
      const slide = sheet.animate(
        [{ transform: `translateY(${fromY}px)` }, { transform: `translateY(${travel}px)` }],
        { duration: 230, easing: 'ease-in', fill: 'forwards' },
      );
      slide.onfinish = () => { backdrop.remove(); sheet.remove(); };
    } else {
      sheet.classList.remove('dragging', 'show');
      sheet.style.transform = '';
      setTimeout(() => { backdrop.remove(); sheet.remove(); }, 400);
    }
  };

  backdrop.addEventListener('click', () => close());
  $('.sheet-close', sheet)?.addEventListener('click', () => close());
  makeSheetDraggable(sheet, backdrop, close);
  return { sheet, close };
}

/**
 * Drag-to-dismiss from the grip/handle and the title row. The sheet tracks
 * the finger 1:1 (transition disabled while dragging, writes batched in
 * rAF) and either commits (distance or velocity) or springs back.
 * The grip areas have CSS touch-action:none, so no non-passive touch
 * listeners are needed anywhere.
 */
function makeSheetDraggable(sheet, backdrop, close) {
  let active = false;
  let startY = 0, dy = 0, height = 0;
  let lastY = 0, lastT = 0, vel = 0, raf = 0;

  const move = (e) => {
    if (!active) return;
    dy = Math.max(0, e.clientY - startY);
    const now = performance.now();
    if (now - lastT > 0) vel = (e.clientY - lastY) / (now - lastT); // px per ms
    lastY = e.clientY;
    lastT = now;
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        sheet.style.transform = `translateY(${dy}px)`;
        backdrop.style.opacity = String(Math.max(0, 1 - dy / height));
      });
    }
  };

  const up = (e) => {
    if (!active) return;
    active = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    sheet.style.willChange = '';
    backdrop.classList.remove('dragging');

    if (dy > 120 || vel > 0.55) {
      close(dy);
    } else {
      // spring back via the sheet's own CSS transition
      sheet.classList.remove('dragging');
      sheet.style.transform = '';
      backdrop.style.opacity = '';
    }
    e.target.releasePointerCapture?.(e.pointerId);
  };

  for (const grip of $$('.sheet-grip, .sheet-title-row', sheet)) {
    grip.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.target.closest('button')) return; // keep ✕ tappable
      active = true;
      startY = e.clientY;
      lastY = e.clientY;
      lastT = performance.now();
      dy = 0;
      vel = 0;
      height = sheet.offsetHeight; // single layout read per drag
      sheet.classList.add('dragging');
      backdrop.classList.add('dragging');
      sheet.style.willChange = 'transform'; // only while dragging
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }
}

function sheetHeader(title) {
  return `<div class="sheet-title-row">
    <div class="sheet-title">${esc(title)}</div>
    <button class="sheet-close" aria-label="Close">${icon('x', { size: 18 })}</button>
  </div>`;
}

function openConfirmSheet(title, message, confirmLabel, onConfirm) {
  const { sheet, close } = openSheet(`
    ${sheetHeader(title)}
    <p class="muted" style="margin-bottom:20px">${esc(message)}</p>
    <button class="btn danger block" id="cf-yes">${esc(confirmLabel)}</button>
    <div class="spacer-8"></div>
    <button class="btn ghost block" id="cf-no">Cancel</button>`);
  $('#cf-yes', sheet).addEventListener('click', () => { close(); onConfirm(); });
  $('#cf-no', sheet).addEventListener('click', () => close());
}

/* ==========================================================================
   Task form sheet (add & edit)
   ========================================================================== */

/**
 * Downscales and re-encodes an image before it is kept as base64, so
 * localStorage writes (which are synchronous) stay small and fast.
 */
async function compressImage(file, maxDim = 1280, quality = 0.82) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', quality);
}

function reminderOffsetMinutes(task) {
  if (!task?.reminderAt || !task?.dueDate) return '';
  const diff = Math.round((smart.dueDateTime(task) - new Date(task.reminderAt)) / 60000);
  return [0, 10, 60, 1440].includes(diff) ? String(diff) : '';
}

function openTaskSheet(existing = null, defaults = {}) {
  const isEdit = !!existing;
  const projects = db.getProjects();
  const allTasks = db.getTasks();

  // mutable selections held in this closure
  const sel = {
    category: existing?.category ?? defaults.category ?? null,
    priority: existing?.priority ?? 'medium',
    recurrence: existing?.recurrence ?? null,
    attachments: [...(existing?.attachments || [])],
    manualCategory: !!existing?.category,
  };

  const { sheet, close } = openSheet(`
    ${sheetHeader(isEdit ? 'Edit Task' : 'New Task')}
    <div class="field">
      <input id="tf-title" class="input" placeholder="What do you need to do?"
             value="${esc(existing?.title || '')}" autocomplete="off">
      <div id="tf-suggest"></div>
    </div>
    <div class="field">
      <label>Notes</label>
      <textarea id="tf-notes" class="input" placeholder="Add details…">${esc(existing?.notes || '')}</textarea>
    </div>
    <div class="field">
      <label>Category</label>
      <div class="chips" id="tf-cats"></div>
    </div>
    <div class="field">
      <label>Priority</label>
      <div class="seg" id="tf-priority">
        ${Object.entries(PRIORITY).map(([key, p]) => `
          <button class="seg-btn p-${key}" data-p="${key}">${icon('flag', { size: 14 })}${p.label}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label>List</label>
      <select id="tf-project" class="input">
        ${projects.map((p) => `<option value="${p.id}" ${(existing?.projectId ?? defaults.projectId ?? 'inbox') === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Due date</label>
        <input id="tf-date" type="date" class="input" value="${existing?.dueDate || defaults.dueDate || ''}">
      </div>
      <div class="field">
        <label>Time</label>
        <input id="tf-time" type="time" class="input" value="${existing?.dueTime || ''}">
      </div>
    </div>
    <div class="field">
      <label>Repeat</label>
      <div class="seg" id="tf-rec">
        ${['', 'daily', 'weekly', 'monthly'].map((r) => `
          <button class="seg-btn" data-r="${r}">${r ? RECURRENCE_LABEL[r] : 'None'}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label>Reminder</label>
      <select id="tf-reminder" class="input">
        <option value="">No reminder</option>
        <option value="0">At due time</option>
        <option value="10">10 minutes before</option>
        <option value="60">1 hour before</option>
        <option value="1440">1 day before</option>
      </select>
    </div>
    <div class="field">
      <label>Attachments</label>
      <div class="thumbs" id="tf-thumbs"></div>
      <input id="tf-file" type="file" accept="image/*" hidden>
    </div>
    <button class="btn block" id="tf-save">${icon('check', { size: 18 })}${isEdit ? 'Save Changes' : 'Add Task'}</button>`);

  $('#tf-reminder', sheet).value = reminderOffsetMinutes(existing);

  /* --- category chips --- */
  function renderCats() {
    $('#tf-cats', sheet).innerHTML = db.getCategories().map((c) => `
      <button class="pill c-${c.color} ${sel.category === c.id ? 'active' : ''}" data-cat="${c.id}">
        <span class="dot c-${c.color}"></span>${esc(c.name)}</button>`).join('') +
      `<button class="pill" data-cat="__new">${icon('plus', { size: 14 })}New</button>`;
    $$('#tf-cats .pill', sheet).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.cat === '__new') {
        openCategorySheet((newCat) => { sel.category = newCat.id; sel.manualCategory = true; renderCats(); });
        return;
      }
      sel.category = sel.category === b.dataset.cat ? null : b.dataset.cat;
      sel.manualCategory = sel.category !== null;
      renderCats();
    }));
  }
  renderCats();

  /* --- priority & recurrence segments --- */
  function renderSeg(rootSel, attr, current) {
    $$(rootSel + ' .seg-btn', sheet).forEach((b) =>
      b.classList.toggle('active', (b.dataset[attr] || null) === current || b.dataset[attr] === (current ?? '')));
  }
  renderSeg('#tf-priority', 'p', sel.priority);
  renderSeg('#tf-rec', 'r', sel.recurrence ?? '');
  $$('#tf-priority .seg-btn', sheet).forEach((b) => b.addEventListener('click', () => {
    sel.priority = b.dataset.p;
    renderSeg('#tf-priority', 'p', sel.priority);
  }));
  $$('#tf-rec .seg-btn', sheet).forEach((b) => b.addEventListener('click', () => {
    sel.recurrence = b.dataset.r || null;
    renderSeg('#tf-rec', 'r', sel.recurrence ?? '');
  }));

  /* --- attachments --- */
  function renderThumbs() {
    $('#tf-thumbs', sheet).innerHTML = sel.attachments.map((a, i) => `
      <div class="thumb"><img src="${a.dataUrl}" alt="${esc(a.name)}">
        <button class="rm" data-i="${i}" aria-label="Remove">${icon('x', { size: 12 })}</button></div>`).join('') +
      `<button class="thumb-add" id="tf-add-file" aria-label="Add image">${icon('image', { size: 22 })}</button>`;
    $$('#tf-thumbs .rm', sheet).forEach((b) => b.addEventListener('click', () => {
      sel.attachments.splice(Number(b.dataset.i), 1);
      renderThumbs();
    }));
    $('#tf-add-file', sheet).addEventListener('click', () => $('#tf-file', sheet).click());
  }
  renderThumbs();
  $('#tf-file', sheet).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      showToast('Image too large — please pick one under 12 MB');
      return;
    }
    try {
      const dataUrl = await compressImage(file);
      sel.attachments.push({ id: db.uid(), name: file.name, dataUrl });
      renderThumbs();
    } catch {
      // some formats can't be decoded by createImageBitmap — store as-is
      const reader = new FileReader();
      reader.onload = () => {
        sel.attachments.push({ id: db.uid(), name: file.name, dataUrl: reader.result });
        renderThumbs();
      };
      reader.readAsDataURL(file);
    }
  });

  /* --- smart suggestions while typing --- */
  const refreshSuggestions = debounce(() => {
    const title = $('#tf-title', sheet).value;
    const out = [];
    const catSug = smart.suggestCategory(title, db.getCategories());
    if (catSug && !sel.manualCategory && sel.category !== catSug.id) {
      out.push(`<button class="suggest-chip" data-sug="cat" data-id="${catSug.id}">
        ${icon('sparkles', { size: 14 })}Category: ${esc(catSug.name)}</button>`);
    }
    const recSug = smart.suggestRecurrence(title, allTasks);
    if (recSug && !sel.recurrence) {
      out.push(`<button class="suggest-chip" data-sug="rec" data-id="${recSug}">
        ${icon('repeat', { size: 14 })}Repeat ${recSug}? You do this often</button>`);
    }
    $('#tf-suggest', sheet).innerHTML = out.join(' ');
    $$('#tf-suggest .suggest-chip', sheet).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.sug === 'cat') { sel.category = b.dataset.id; sel.manualCategory = true; renderCats(); }
      else { sel.recurrence = b.dataset.id; renderSeg('#tf-rec', 'r', sel.recurrence); }
      b.remove();
    }));
  }, 250);
  $('#tf-title', sheet).addEventListener('input', refreshSuggestions);
  if (!isEdit) refreshSuggestions();

  /* --- save --- */
  $('#tf-save', sheet).addEventListener('click', () => {
    const title = $('#tf-title', sheet).value.trim();
    if (!title) {
      $('#tf-title', sheet).focus();
      showToast('Give your task a title first');
      return;
    }
    const dueDate = $('#tf-date', sheet).value || null;
    const dueTime = $('#tf-time', sheet).value || null;

    // reminderAt is derived from the due date/time and the chosen lead time
    let reminderAt = null;
    const offset = $('#tf-reminder', sheet).value;
    if (offset !== '' && dueDate) {
      const due = smart.dueDateTime({ dueDate, dueTime: dueTime || '09:00' });
      reminderAt = new Date(due.getTime() - Number(offset) * 60000).toISOString();
    }

    const task = {
      ...(existing || {}),
      title,
      notes: $('#tf-notes', sheet).value.trim(),
      category: sel.category,
      priority: sel.priority,
      projectId: $('#tf-project', sheet).value,
      dueDate, dueTime,
      recurrence: sel.recurrence,
      attachments: sel.attachments,
      reminderAt,
      completed: existing?.completed || false,
      completedAt: existing?.completedAt || null,
    };
    db.saveTask(task);

    // ask for notification permission the first time a reminder is set
    if (reminderAt && notify.permission() === 'default') notify.requestPermission();

    close();
    refreshUI();
    showToast(isEdit ? 'Task updated' : 'Task added');
  });

  if (!isEdit) setTimeout(() => $('#tf-title', sheet).focus(), 420);
}

/* ==========================================================================
   New category / new list sheets
   ========================================================================== */

function swatchesHTML(selected) {
  return `<div class="swatches">${COLOR_NAMES.map((c) => `
    <button class="swatch ${c === selected ? 'active' : ''}" data-c="${c}"
            style="background:${COLOR_HEX[c]}" aria-label="${c}"></button>`).join('')}</div>`;
}

function openCategorySheet(onCreated) {
  let color = COLOR_NAMES[Math.floor(Math.random() * 5)];
  const existing = db.getCategories();

  const { sheet, close } = openSheet(`
    ${sheetHeader('New Category')}
    <div class="field">
      <label>Name</label>
      <input id="nc-name" class="input" placeholder="e.g. Errands" autocomplete="off">
    </div>
    <div class="field"><label>Color</label>${swatchesHTML(color)}</div>
    <button class="btn block" id="nc-save">${icon('plus', { size: 18 })}Create Category</button>
    ${existing.length ? `
      <div class="group-label">Your categories</div>
      <div class="chips">${existing.map((c) => `
        <span class="pill"><span class="dot c-${c.color}"></span>${esc(c.name)}
          <button data-del="${c.id}" aria-label="Delete ${esc(c.name)}" style="display:inline-grid">${icon('x', { size: 13 })}</button>
        </span>`).join('')}</div>` : ''}`);

  $$('.swatch', sheet).forEach((s) => s.addEventListener('click', () => {
    color = s.dataset.c;
    $$('.swatch', sheet).forEach((x) => x.classList.toggle('active', x === s));
  }));
  $$('[data-del]', sheet).forEach((b) => b.addEventListener('click', () => {
    db.deleteCategory(b.dataset.del);
    b.closest('.pill').remove();
    render();
  }));
  $('#nc-save', sheet).addEventListener('click', () => {
    const name = $('#nc-name', sheet).value.trim();
    if (!name) { $('#nc-name', sheet).focus(); return; }
    const cat = db.saveCategory({ name, color });
    close();
    render();
    onCreated?.(cat);
  });
  setTimeout(() => $('#nc-name', sheet).focus(), 420);
}

function openListsSheet() {
  let color = 'blue';
  const tasks = db.getTasks();

  const { sheet, close } = openSheet(`
    ${sheetHeader('Lists')}
    <div class="task-list" id="ls-rows">
      ${db.getProjects().map((p) => {
        const count = tasks.filter((t) => t.projectId === p.id && !t.completed).length;
        return `
        <div class="task-row" data-pick="${p.id}">
          <span class="dot c-${p.color}" style="width:12px;height:12px"></span>
          <div class="task-main"><div class="task-title">${esc(p.name)}</div></div>
          <span class="meta-chip">${count} open</span>
          ${p.id !== 'inbox' ? `<button class="sheet-close" data-del="${p.id}" aria-label="Delete list">${icon('trash', { size: 15 })}</button>` : ''}
        </div>`;
      }).join('')}
    </div>
    <div class="group-label">New list</div>
    <div class="field">
      <input id="nl-name" class="input" placeholder="e.g. Side project" autocomplete="off">
    </div>
    <div class="field">${swatchesHTML(color)}</div>
    <button class="btn block" id="nl-save">${icon('plus', { size: 18 })}Create List</button>`);

  $$('.swatch', sheet).forEach((s) => s.addEventListener('click', () => {
    color = s.dataset.c;
    $$('.swatch', sheet).forEach((x) => x.classList.toggle('active', x === s));
  }));
  $$('#ls-rows [data-pick]', sheet).forEach((row) => row.addEventListener('click', () => {
    state.projectId = row.dataset.pick;
    close();
    switchTab('tasks');
  }));
  $$('#ls-rows [data-del]', sheet).forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    openConfirmSheet('Delete list?',
      'Tasks in this list will move back to your Inbox.', 'Delete List', () => {
        db.deleteProject(b.dataset.del);
        if (state.projectId === b.dataset.del) state.projectId = null;
        close();
        render();
      });
  }));
  $('#nl-save', sheet).addEventListener('click', () => {
    const name = $('#nl-name', sheet).value.trim();
    if (!name) { $('#nl-name', sheet).focus(); return; }
    const proj = db.saveProject({ name, color });
    state.projectId = proj.id;
    close();
    switchTab('tasks');
  });
}

/* ==========================================================================
   Task detail sheet
   ========================================================================== */

function openDetailSheet(id) {
  const task = db.getTask(id);
  if (!task) return;
  const cat = categoryOf(task);
  const project = db.getProjects().find((p) => p.id === task.projectId);

  const metaRow = (ic, html) =>
    `<div class="detail-meta-row">${icon(ic, { size: 18 })}<span>${html}</span></div>`;

  const rows = [];
  if (task.dueDate) {
    rows.push(metaRow('calendar', `${smart.isOverdue(task)
      ? `<span class="meta-chip overdue">Overdue</span> ` : ''}${esc(fmtDueLabel(task))}`));
  }
  if (cat) rows.push(metaRow('tag', `<span class="meta-chip c-${cat.color}"><span class="dot c-${cat.color}"></span>${esc(cat.name)}</span>`));
  rows.push(metaRow('flag', `<span class="meta-chip ${PRIORITY[task.priority]?.cls || ''}">${PRIORITY[task.priority]?.label || 'Medium'} priority</span>`));
  if (project) rows.push(metaRow('folder', esc(project.name)));
  if (task.recurrence) rows.push(metaRow('repeat', `Repeats ${RECURRENCE_LABEL[task.recurrence].toLowerCase()}`));
  if (task.reminderAt) {
    rows.push(metaRow('bell', `Reminder ${new Date(task.reminderAt)
      .toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`));
  }
  if (task.completed && task.completedAt) {
    rows.push(metaRow('check-circle', `<span class="meta-chip done">Done</span> ${new Date(task.completedAt)
      .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`));
  }

  const { sheet, close } = openSheet(`
    ${sheetHeader(task.completed ? 'Completed Task' : 'Task')}
    <div class="detail-head">
      <div class="detail-title">${esc(task.title)}</div>
    </div>
    <div class="detail-meta card" style="padding:6px 16px">${rows.join('')}</div>
    <div class="spacer-16"></div>
    ${task.notes ? `<div class="detail-notes">${esc(task.notes)}</div>` : ''}
    ${task.attachments?.length ? `
      <div class="field"><label>Attachments</label>
        <div class="thumbs">${task.attachments.map((a) => `
          <button class="thumb" data-img="${a.id}"><img src="${a.dataUrl}" alt="${esc(a.name)}"></button>`).join('')}
        </div>
      </div>` : ''}
    <div class="detail-actions">
      <button class="btn ghost" id="dt-complete">
        ${icon(task.completed ? 'rotate-ccw' : 'check', { size: 17 })}${task.completed ? 'Reopen' : 'Complete'}
      </button>
      <button class="btn" id="dt-edit">${icon('pencil', { size: 16 })}Edit</button>
    </div>
    <div class="spacer-8"></div>
    <button class="btn danger block" id="dt-delete">${icon('trash', { size: 16 })}Delete Task</button>`);

  $$('[data-img]', sheet).forEach((b) => b.addEventListener('click', () => {
    const att = task.attachments.find((a) => a.id === b.dataset.img);
    if (att) openImageViewer(att.dataUrl);
  }));
  $('#dt-complete', sheet).addEventListener('click', () => { close(); toggleComplete(id, null); });
  $('#dt-edit', sheet).addEventListener('click', () => { close(); openTaskSheet(task); });
  $('#dt-delete', sheet).addEventListener('click', () => { close(); deleteTaskWithUndo(id); });
}

function openImageViewer(src) {
  const viewer = document.createElement('div');
  viewer.className = 'viewer';
  viewer.innerHTML = `<img src="${src}" alt="">`;
  viewer.addEventListener('click', () => viewer.remove());
  document.body.append(viewer);
}

/* ==========================================================================
   Filters sheet
   ========================================================================== */

function openFiltersSheet() {
  const draft = { ...state.filters };
  const categories = db.getCategories();

  const { sheet, close } = openSheet(`
    ${sheetHeader('Filters')}
    <div class="field">
      <label>Status</label>
      <div class="seg" id="fl-status">
        ${[['all', 'All'], ['open', 'Open'], ['done', 'Done']].map(([v, l]) =>
          `<button class="seg-btn" data-v="${v}">${l}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label>Due</label>
      <div class="seg" id="fl-due">
        ${[['any', 'Any'], ['today', 'Today'], ['week', 'Week'], ['overdue', 'Late']].map(([v, l]) =>
          `<button class="seg-btn" data-v="${v}">${l}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label>Category</label>
      <div class="chips" id="fl-cat">
        <button class="pill" data-v="">All</button>
        ${categories.map((c) => `<button class="pill c-${c.color}" data-v="${c.id}">
          <span class="dot c-${c.color}"></span>${esc(c.name)}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label>Priority</label>
      <div class="chips" id="fl-pri">
        <button class="pill" data-v="">Any</button>
        ${Object.entries(PRIORITY).map(([key, p]) =>
          `<button class="pill" data-v="${key}">${icon('flag', { size: 13 })}${p.label}</button>`).join('')}
      </div>
    </div>
    <div class="detail-actions">
      <button class="btn ghost" id="fl-reset">Reset</button>
      <button class="btn" id="fl-apply">Apply Filters</button>
    </div>`);

  function paint() {
    $$('#fl-status .seg-btn', sheet).forEach((b) => b.classList.toggle('active', b.dataset.v === draft.status));
    $$('#fl-due .seg-btn', sheet).forEach((b) => b.classList.toggle('active', b.dataset.v === draft.due));
    $$('#fl-cat .pill', sheet).forEach((b) => b.classList.toggle('active', (b.dataset.v || null) === draft.category));
    $$('#fl-pri .pill', sheet).forEach((b) => b.classList.toggle('active', (b.dataset.v || null) === draft.priority));
  }
  paint();

  $$('#fl-status .seg-btn', sheet).forEach((b) => b.addEventListener('click', () => { draft.status = b.dataset.v; paint(); }));
  $$('#fl-due .seg-btn', sheet).forEach((b) => b.addEventListener('click', () => { draft.due = b.dataset.v; paint(); }));
  $$('#fl-cat .pill', sheet).forEach((b) => b.addEventListener('click', () => { draft.category = b.dataset.v || null; paint(); }));
  $$('#fl-pri .pill', sheet).forEach((b) => b.addEventListener('click', () => { draft.priority = b.dataset.v || null; paint(); }));

  $('#fl-reset', sheet).addEventListener('click', () => {
    state.filters = { status: 'all', category: null, priority: null, due: 'any' };
    close();
    refreshUI();
  });
  $('#fl-apply', sheet).addEventListener('click', () => {
    state.filters = draft;
    close();
    refreshUI();
  });
}

/** Applies search + filter state to a task array. */
function applyFilters(tasks) {
  const f = state.filters;
  const q = state.search.trim().toLowerCase();
  return tasks.filter((t) => {
    if (q && !(`${t.title} ${t.notes}`.toLowerCase().includes(q))) return false;
    if (f.status === 'open' && t.completed) return false;
    if (f.status === 'done' && !t.completed) return false;
    if (f.category && t.category !== f.category) return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (f.due === 'today' && !smart.isDueToday(t)) return false;
    if (f.due === 'week' && !(smart.isDueToday(t) || smart.isDueSoon(t, 24 * 7))) return false;
    if (f.due === 'overdue' && !smart.isOverdue(t)) return false;
    return true;
  });
}

/* ==========================================================================
   Notifications (bell) sheet
   ========================================================================== */

function openBellSheet() {
  const tasks = db.getTasks();
  const overdue = smart.getOverdueTasks(tasks);
  const dueSoon = smart.getDueSoonTasks(tasks);
  const perm = notify.permission();

  const { sheet, close } = openSheet(`
    ${sheetHeader('Notifications')}
    ${perm !== 'granted' && perm !== 'unsupported' ? `
      <div class="notice">${icon('bell', { size: 18 })}
        <span>Enable notifications to get reminders while Taskly is open or installed.</span>
      </div>
      <button class="btn block" id="bl-enable">${icon('bell', { size: 17 })}Enable Notifications</button>
      <div class="spacer-16"></div>` : ''}
    ${overdue.length ? `
      <div class="section-head"><h2>${icon('alert', { size: 18 })} Overdue</h2>
        <span class="count">${overdue.length}</span></div>
      <div class="task-list" id="bl-overdue">${overdue.map(taskItemHTML).join('')}</div>` : ''}
    ${dueSoon.length ? `
      <div class="section-head"><h2>${icon('clock', { size: 18 })} Due soon</h2>
        <span class="count">${dueSoon.length}</span></div>
      <div class="task-list" id="bl-soon">${dueSoon.map(taskItemHTML).join('')}</div>` : ''}
    ${!overdue.length && !dueSoon.length ? `
      <div class="empty-card">
        <div class="ring">${icon('check-circle', { size: 28 })}</div>
        <h3>Nothing urgent</h3><p>No overdue or upcoming deadlines. Nice work!</p>
      </div>` : ''}`);

  $('#bl-enable', sheet)?.addEventListener('click', async () => {
    await notify.requestPermission();
    close();
    showToast(notify.permission() === 'granted'
      ? 'Notifications enabled' : 'Notifications were not enabled');
  });
  // rows inside the sheet close it first, then act on the main view
  const opts = { swipe: false, beforeOpen: () => close() };
  for (const listSel of ['#bl-overdue', '#bl-soon']) {
    const list = $(listSel, sheet);
    if (list) bindList(list, opts);
  }
}

/* ==========================================================================
   View: Today
   ========================================================================== */

function greetingWord() {
  const h = new Date().getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function renderToday(view) {
  const name = db.getSettings().name.trim();
  const dateLabel = new Date().toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric' });

  view.innerHTML = `
    <div class="topbar">
      <div>
        <div class="greeting-sub">${dateLabel}</div>
        <div class="greeting">${greetingWord()}${name ? `, ${esc(name)}` : ''}</div>
      </div>
      <div class="topbar-actions">
        <button class="icon-btn" id="td-bell" aria-label="Notifications">
          ${icon('bell', { size: 20 })}<span class="alert-dot" id="td-dot" hidden></span>
        </button>
        <div class="avatar">${name ? esc(name[0].toUpperCase()) : icon('user', { size: 20 })}</div>
      </div>
    </div>

    <button class="searchbar" id="td-search" style="width:100%">
      ${icon('search', { size: 19 })}<span style="color:var(--text-3);font-size:16px">Search tasks…</span>
    </button>

    <div class="hero-card">
      <div class="hero-kicker">Today's progress</div>
      <div class="hero-title" id="td-hero-title"></div>
      <div class="hero-stats">
        <div class="hero-stat"><div class="n" id="td-n-done">0</div><div class="l">Done</div></div>
        <div class="hero-stat"><div class="n" id="td-n-open">0</div><div class="l">Open today</div></div>
        <div class="hero-stat"><div class="n" id="td-n-over">0</div><div class="l">Overdue</div></div>
      </div>
      <div class="progressbar"><i id="td-progress"></i></div>
    </div>

    <section id="td-sec-overdue" hidden>
      <div class="section-head"><h2>Overdue</h2><span class="count" id="td-c-overdue"></span></div>
      <div class="task-list" id="td-l-overdue"></div>
    </section>

    <section id="td-sec-today" hidden>
      <div class="section-head"><h2>Today</h2><span class="count" id="td-c-today"></span></div>
      <div class="task-list" id="td-l-today"></div>
    </section>

    <section id="td-sec-next" hidden>
      <div class="section-head"><h2>${icon('sparkles', { size: 17 })} Up next</h2>
        <button class="link" id="td-all">See all</button></div>
      <div class="task-list" id="td-l-next"></div>
    </section>

    <div id="td-empty" hidden>
      <div class="spacer-16"></div>
      <div class="empty-card">
        <div class="ring">${icon('sparkles', { size: 28 })}</div>
        <h3>You're all caught up</h3>
        <p>No urgent tasks right now. Add something new or enjoy the calm.</p>
        <div class="spacer-16"></div>
        <button class="btn gradient" id="td-add">${icon('plus', { size: 17 })}New Task</button>
      </div>
    </div>

    <section id="td-sec-done" hidden>
      <div class="section-head"><h2>Done today</h2><span class="count" id="td-c-done"></span></div>
      <div class="task-list" id="td-l-done"></div>
    </section>`;

  const els = {
    heroTitle: $('#td-hero-title', view),
    nDone: $('#td-n-done', view),
    nOpen: $('#td-n-open', view),
    nOver: $('#td-n-over', view),
    progress: $('#td-progress', view),
    dot: $('#td-dot', view),
    empty: $('#td-empty', view),
    sections: {
      overdue: [$('#td-sec-overdue', view), $('#td-l-overdue', view), $('#td-c-overdue', view)],
      today:   [$('#td-sec-today', view),   $('#td-l-today', view),   $('#td-c-today', view)],
      next:    [$('#td-sec-next', view),    $('#td-l-next', view),    null],
      done:    [$('#td-sec-done', view),    $('#td-l-done', view),    $('#td-c-done', view)],
    },
  };

  /** Targeted update: only rows/labels that changed are touched. */
  function refresh({ flip = true } = {}) {
    const tasks = db.getTasks();
    const { overdue, today, suggested, doneToday } = smart.buildToday(tasks);
    const lists = {
      overdue, today, next: suggested, done: doneToday.slice(0, 5),
    };
    const openToday = today.length;
    const totalToday = openToday + doneToday.length;
    const pct = totalToday ? Math.round((doneToday.length / totalToday) * 100) : 0;
    const nothingOpen = !overdue.length && !openToday && !suggested.length;

    const apply = () => {
      els.heroTitle.innerHTML =
        nothingOpen && !totalToday ? 'A fresh start.<br>Plan something great.' :
        openToday === 0 && !overdue.length && totalToday > 0 ? 'All done for today.<br>You crushed it!' :
        `You have <br>${openToday + overdue.length} task${openToday + overdue.length === 1 ? '' : 's'} to go`;
      els.nDone.textContent = doneToday.length;
      els.nOpen.textContent = openToday;
      els.nOver.textContent = overdue.length;
      els.progress.style.transform = `scaleX(${pct / 100})`;
      els.dot.hidden = overdue.length + smart.getDueSoonTasks(tasks).length === 0;
      els.empty.hidden = !nothingOpen;
      for (const [key, [sec, list, count]] of Object.entries(els.sections)) {
        sec.hidden = lists[key].length === 0;
        if (count) count.textContent = lists[key].length;
        reconcileTaskList(list, lists[key]);
      }
    };
    if (flip) withFlip(view, apply); else apply();
  }

  // initial fill renders everything at once; afterwards, targeted updates only
  {
    const tasks = db.getTasks();
    const { overdue, today, suggested, doneToday } = smart.buildToday(tasks);
    const fill = (list, items) => {
      list.innerHTML = items.map(taskItemHTML).join('');
      bindList(list);
    };
    fill(els.sections.overdue[1], overdue);
    fill(els.sections.today[1], today);
    fill(els.sections.next[1], suggested);
    fill(els.sections.done[1], doneToday.slice(0, 5));
    refresh({ flip: false });
  }
  state.refresh = refresh;

  $('#td-bell', view).addEventListener('click', openBellSheet);
  $('#td-search', view).addEventListener('click', () => {
    switchTab('tasks');
    setTimeout(() => $('#ts-search')?.focus(), 380);
  });
  $('#td-all', view)?.addEventListener('click', () => switchTab('tasks'));
  $('#td-add', view)?.addEventListener('click', () => openTaskSheet(null, { dueDate: smart.todayStr() }));
}

/* ==========================================================================
   View: Tasks
   ========================================================================== */

function tasksViewData() {
  let tasks = db.getTasks();
  if (state.projectId) tasks = tasks.filter((t) => t.projectId === state.projectId);
  tasks = applyFilters(tasks);

  const open = tasks.filter((t) => !t.completed).sort((a, b) => {
    const od = smart.isOverdue(b) - smart.isOverdue(a);
    if (od) return od;
    const da = a.dueDate || '9999';
    const dbb = b.dueDate || '9999';
    if (da !== dbb) return da < dbb ? -1 : 1;
    const pr = { high: 0, medium: 1, low: 2 };
    return (pr[a.priority] ?? 1) - (pr[b.priority] ?? 1);
  });
  const done = tasks.filter((t) => t.completed)
    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
  return { open, done };
}

function renderTasks(view) {
  const projects = db.getProjects();

  view.innerHTML = `
    <h1 class="page-title">Your <span class="light">tasks</span></h1>
    <p class="subtitle" id="ts-sub"></p>
    <div class="spacer-16"></div>

    <div class="search-row">
      <div class="searchbar">
        ${icon('search', { size: 19 })}
        <input id="ts-search" placeholder="Search tasks…" value="${esc(state.search)}" autocomplete="off">
      </div>
      <button class="filter-btn" id="ts-filter" aria-label="Filters">
        ${icon('sliders', { size: 20 })}<span class="count" id="ts-fcount" hidden></span>
      </button>
    </div>

    <div class="pill-row" id="ts-projects">
      <button class="pill ${state.projectId === null ? 'active' : ''}" data-proj="">All</button>
      ${projects.map((p) => `
        <button class="pill c-${p.color} ${state.projectId === p.id ? 'active' : ''}" data-proj="${p.id}">
          <span class="dot c-${p.color}"></span>${esc(p.name)}</button>`).join('')}
      <button class="pill" id="ts-lists">${icon('plus', { size: 14 })}List</button>
    </div>

    <div class="task-list" id="ts-open"></div>
    <div id="ts-empty" hidden>
      <div class="empty-card">
        <div class="ring">${icon('inbox', { size: 28 })}</div>
        <h3 id="ts-empty-h"></h3><p id="ts-empty-p"></p>
      </div>
    </div>
    <div id="ts-done-sec" hidden>
      <div class="section-head">
        <h2>Completed</h2>
        <button class="link" id="ts-toggle-done"></button>
      </div>
      <div class="task-list" id="ts-done"></div>
    </div>`;

  const els = {
    sub: $('#ts-sub', view),
    open: $('#ts-open', view),
    empty: $('#ts-empty', view),
    emptyH: $('#ts-empty-h', view),
    emptyP: $('#ts-empty-p', view),
    doneSec: $('#ts-done-sec', view),
    doneList: $('#ts-done', view),
    toggle: $('#ts-toggle-done', view),
    filterBtn: $('#ts-filter', view),
    fcount: $('#ts-fcount', view),
  };

  /** Targeted update — search/filter/toggle never rebuild untouched rows. */
  function refresh({ flip = true } = {}) {
    const { open, done } = tasksViewData();
    const apply = () => {
      reconcileTaskList(els.open, open);
      els.empty.hidden = open.length > 0;
      if (!open.length) {
        const filtered = !!(state.search.trim() || activeFilterCount());
        els.emptyH.textContent = filtered ? 'No matching tasks' : 'Nothing here yet';
        els.emptyP.textContent = filtered
          ? 'Try changing your search or filters.'
          : 'Tap the + button to add your first task.';
      }
      els.doneSec.hidden = done.length === 0;
      els.toggle.textContent = state.showCompleted ? 'Hide' : `Show (${done.length})`;
      reconcileTaskList(els.doneList, state.showCompleted ? done : []);
      els.sub.textContent = `${open.length} open · ${done.length} completed`;
      const n = activeFilterCount();
      els.filterBtn.classList.toggle('on', n > 0);
      els.fcount.hidden = n === 0;
      els.fcount.textContent = n;
    };
    if (flip) withFlip(view, apply); else apply();
  }

  // initial fill renders everything at once; afterwards, targeted updates only
  {
    const { open, done } = tasksViewData();
    els.open.innerHTML = open.map(taskItemHTML).join('');
    bindList(els.open);
    if (state.showCompleted) {
      els.doneList.innerHTML = done.map(taskItemHTML).join('');
      bindList(els.doneList);
    }
    refresh({ flip: false });
  }
  state.refresh = refresh;

  // live search re-filters with targeted updates; input keeps focus
  $('#ts-search', view).addEventListener('input', debounce((e) => {
    state.search = e.target.value;
    refresh();
  }, 150));

  els.toggle.addEventListener('click', () => {
    state.showCompleted = !state.showCompleted;
    refresh();
  });

  $('#ts-filter', view).addEventListener('click', openFiltersSheet);
  $('#ts-lists', view).addEventListener('click', openListsSheet);
  $$('#ts-projects [data-proj]', view).forEach((b) => b.addEventListener('click', () => {
    state.projectId = b.dataset.proj || null;
    $$('#ts-projects [data-proj]', view).forEach((p) =>
      p.classList.toggle('active', (p.dataset.proj || null) === state.projectId));
    refresh();
  }));
}

/* ==========================================================================
   View: Stats
   ========================================================================== */

/** N days of completion counts, oldest first: [{date, label, count}] */
function dailyCompletions(tasks, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = smart.toISODate(d);
    out.push({
      date: iso,
      label: d.toLocaleDateString('en-US', { weekday: 'narrow' }),
      count: tasks.filter((t) => t.completedAt && smart.toISODate(new Date(t.completedAt)) === iso).length,
    });
  }
  return out;
}

/** Consecutive days with at least one completion, ending today or yesterday. */
function calcStreak(tasks) {
  const days = new Set(tasks
    .filter((t) => t.completedAt)
    .map((t) => smart.toISODate(new Date(t.completedAt))));
  let streak = 0;
  const cursor = new Date();
  if (!days.has(smart.toISODate(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(smart.toISODate(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/* --- chart builders (pure SVG, no libraries; rendered in final state,
   no entrance animation, so the Stats tab is complete the moment it
   appears) --- */

function barChartSVG(data) {
  const W = 360, H = 170, top = 26, bottom = 30;
  const max = Math.max(...data.map((d) => d.count), 1);
  const slot = W / data.length;
  const barW = Math.min(34, slot * 0.55);

  const bars = data.map((d, i) => {
    const h = d.count === 0 ? 5 : (d.count / max) * (H - top - bottom);
    const x = slot * i + (slot - barW) / 2;
    const y = H - bottom - h;
    const color = d.count === 0 ? 'var(--surface-2)' : CHART_PALETTE[i % CHART_PALETTE.length];
    return `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}"
            rx="${Math.min(9, barW / 2)}" fill="${color}"/>
      ${d.count ? `<text class="bar-value"
            x="${(x + barW / 2).toFixed(1)}" y="${(y - 7).toFixed(1)}" text-anchor="middle">${d.count}</text>` : ''}
      <text class="bar-label" x="${(x + barW / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle">${d.label}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tasks completed per day">${bars}</svg>`;
}

function lineChartSVG(data) {
  const W = 360, H = 150, pad = 14, bottom = 26;
  const max = Math.max(...data.map((d) => d.count), 1);
  const stepX = (W - pad * 2) / (data.length - 1);
  const pts = data.map((d, i) => [
    pad + i * stepX,
    H - bottom - (d.count / max) * (H - bottom - pad),
  ]);

  // smooth the line with simple Catmull-Rom → Bézier conversion
  let path = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    path += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }

  const area = `${path} L ${pts[pts.length - 1][0]} ${H - bottom} L ${pts[0][0]} ${H - bottom} Z`;
  const labels = data.map((d, i) => i % 2 === 0
    ? `<text class="bar-label" x="${(pad + i * stepX).toFixed(1)}" y="${H - 8}" text-anchor="middle">${d.label}</text>` : '').join('');
  const dots = pts.map(([x, y], i) => data[i].count
    ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="#5B6CFF"/>` : '').join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Activity line chart">
    <defs>
      <linearGradient id="lc-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#5B6CFF" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="#5B6CFF" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="lc-stroke" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#5B6CFF"/><stop offset="100%" stop-color="#9D6BFF"/>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#lc-fill)"/>
    <path d="${path}" fill="none" stroke="url(#lc-stroke)"
          stroke-width="3" stroke-linecap="round"/>
    ${dots}${labels}</svg>`;
}

function renderStats(view) {
  const tasks = db.getTasks();
  const open = tasks.filter((t) => !t.completed).length;
  const done = tasks.filter((t) => t.completed).length;
  const weekAgo = Date.now() - 7 * 86400000;
  const doneThisWeek = tasks.filter((t) => t.completedAt && Date.parse(t.completedAt) >= weekAgo).length;
  const doneTodayN = tasks.filter((t) => t.completedAt
    && smart.toISODate(new Date(t.completedAt)) === smart.todayStr()).length;
  const streak = calcStreak(tasks);
  const rate = (done + open) ? Math.round((done / (done + open)) * 100) : 0;

  const statCard = (color, ic, n, label) => `
    <div class="stat-card">
      <div class="ico" style="background:var(--${color}-soft);color:var(--${color})">${icon(ic, { size: 19 })}</div>
      <div class="n">${n}</div><div class="l">${label}</div>
    </div>`;

  const categories = db.getCategories();
  const catRows = categories.map((c) => {
    const catTasks = tasks.filter((t) => t.category === c.id);
    if (!catTasks.length) return '';
    const completed = catTasks.filter((t) => t.completed).length;
    const pct = Math.round((completed / catTasks.length) * 100);
    return `
      <div class="row">
        <div class="top">
          <span class="name"><span class="dot c-${c.color}"></span>${esc(c.name)}</span>
          <span class="pct">${completed}/${catTasks.length} · ${pct}%</span>
        </div>
        <div class="progressbar subtle">
          <i style="transform:scaleX(${pct / 100});background:${COLOR_HEX[c.color]}"></i>
        </div>
      </div>`;
  }).join('');

  view.innerHTML = `
    <h1 class="page-title">Your <span class="light">progress</span></h1>
    <p class="subtitle">Keep the momentum going</p>
    <div class="spacer-16"></div>

    <div class="hero-card cool">
      <div class="hero-kicker">This week</div>
      <div class="hero-title"><span id="st-week">${doneThisWeek}</span> task${doneThisWeek === 1 ? '' : 's'} completed</div>
      <div class="hero-sub">${rate}% of everything on your plate is done</div>
      <div class="progressbar"><i style="transform:scaleX(${rate / 100})"></i></div>
    </div>

    <div class="stats-grid">
      ${statCard('blue', 'target', open, 'Open tasks')}
      ${statCard('mint', 'check-circle', done, 'Completed')}
      ${statCard('orange', 'flame', `${streak}d`, 'Day streak')}
      ${statCard('purple', 'zap', doneTodayN, 'Done today')}
    </div>

    <div class="card chart-card">
      <h3>Completed this week</h3>
      <div class="sub">Tasks checked off per day</div>
      ${barChartSVG(dailyCompletions(tasks, 7))}
    </div>

    <div class="card chart-card">
      <h3>Activity</h3>
      <div class="sub">Last 14 days</div>
      ${lineChartSVG(dailyCompletions(tasks, 14))}
    </div>

    ${catRows ? `
      <div class="card chart-card">
        <h3>By category</h3>
        <div class="sub">Completion per category</div>
        <div class="cat-progress">${catRows}</div>
      </div>` : ''}`;
}

/* ==========================================================================
   View: Profile / Settings
   ========================================================================== */

function renderProfile(view) {
  const settings = db.getSettings();
  const perm = notify.permission();

  view.innerHTML = `
    <h1 class="page-title">Profile <span class="light">&amp; settings</span></h1>
    <div class="spacer-16"></div>

    <div class="settings-group">
      <div class="settings-row">
        <div class="avatar">${settings.name ? esc(settings.name[0].toUpperCase()) : icon('user', { size: 20 })}</div>
        <div class="grow">
          <input class="inline-input" id="pf-name" placeholder="Your name"
                 value="${esc(settings.name)}" autocomplete="off">
          <span class="sub">Shown in your daily greeting</span>
        </div>
      </div>
    </div>

    <div class="group-label">Appearance</div>
    <div class="settings-group" style="padding:14px 16px">
      <div class="seg" id="pf-theme">
        ${[['light', 'sun', 'Light'], ['dark', 'moon', 'Dark'], ['system', 'monitor', 'Auto']].map(([v, ic, l]) =>
          `<button class="seg-btn ${settings.theme === v ? 'active' : ''}" data-v="${v}">${icon(ic, { size: 15 })}${l}</button>`).join('')}
      </div>
    </div>

    <div class="group-label">Notifications</div>
    <div class="settings-group">
      <div class="settings-row">
        <div class="ico" style="background:var(--pink-soft);color:var(--pink)">${icon('bell', { size: 18 })}</div>
        <div class="grow">Reminders
          <span class="sub">${perm === 'granted' ? 'Enabled — fire while the app is open'
            : perm === 'denied' ? 'Blocked in browser settings'
            : perm === 'unsupported' ? 'Not supported on this device'
            : 'Tap enable to allow reminders'}</span>
        </div>
        ${perm === 'default' ? `<button class="btn small" id="pf-notif">Enable</button>`
          : perm === 'granted' ? `<span class="meta-chip done">On</span>` : ''}
      </div>
    </div>

    <div class="group-label">Organize</div>
    <div class="settings-group">
      <button class="settings-row" id="pf-lists">
        <div class="ico" style="background:var(--blue-soft);color:var(--blue)">${icon('folder', { size: 18 })}</div>
        <div class="grow">Manage lists</div>${icon('chevron-right', { size: 18, cls: 'chevron' })}
      </button>
      <button class="settings-row" id="pf-cats">
        <div class="ico" style="background:var(--purple-soft);color:var(--purple)">${icon('tag', { size: 18 })}</div>
        <div class="grow">Manage categories</div>${icon('chevron-right', { size: 18, cls: 'chevron' })}
      </button>
    </div>

    <div class="group-label">Data</div>
    <div class="settings-group">
      <button class="settings-row" id="pf-export">
        <div class="ico" style="background:var(--mint-soft);color:var(--mint)">${icon('download', { size: 18 })}</div>
        <div class="grow">Export backup<span class="sub">Download all data as JSON</span></div>
      </button>
      <button class="settings-row" id="pf-import">
        <div class="ico" style="background:var(--orange-soft);color:var(--orange)">${icon('upload', { size: 18 })}</div>
        <div class="grow">Import backup<span class="sub">Restore from a JSON file</span></div>
      </button>
      <button class="settings-row" id="pf-reset">
        <div class="ico" style="background:var(--red-soft);color:var(--red)">${icon('rotate-ccw', { size: 18 })}</div>
        <div class="grow" style="color:var(--red)">Reset app<span class="sub">Erase everything on this device</span></div>
      </button>
      <input id="pf-import-file" type="file" accept="application/json" hidden>
    </div>

    <div class="group-label">About</div>
    <div class="settings-group">
      <div class="settings-row">
        <div class="ico" style="background:var(--blue-soft);color:var(--blue)">${icon('info', { size: 18 })}</div>
        <div class="grow">Taskly v2.1
          <span class="sub">Offline-first PWA · no account needed</span>
        </div>
      </div>
      <div class="settings-row">
        <div class="ico" style="background:var(--mint-soft);color:var(--mint)">${icon('shield', { size: 18 })}</div>
        <div class="grow">Privacy
          <span class="sub">Your data stays on this device and is never uploaded.</span>
        </div>
      </div>
    </div>`;

  $('#pf-name', view).addEventListener('change', (e) => {
    db.saveSettings({ name: e.target.value.trim() });
    render();
  });

  $$('#pf-theme .seg-btn', view).forEach((b) => b.addEventListener('click', () => {
    db.saveSettings({ theme: b.dataset.v });
    applyTheme();
    render();
  }));

  $('#pf-notif', view)?.addEventListener('click', async () => {
    await notify.requestPermission();
    render();
  });

  $('#pf-lists', view).addEventListener('click', openListsSheet);
  $('#pf-cats', view).addEventListener('click', () => openCategorySheet());

  $('#pf-export', view).addEventListener('click', () => {
    const blob = new Blob([db.exportData()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `taskly-backup-${smart.todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Backup downloaded');
  });

  $('#pf-import', view).addEventListener('click', () => $('#pf-import-file', view).click());
  $('#pf-import-file', view).addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        db.importData(reader.result);
        applyTheme();
        render();
        showToast('Backup imported');
      } catch (err) {
        showToast(err.message || 'Could not import that file');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  $('#pf-reset', view).addEventListener('click', () => {
    openConfirmSheet('Reset app?',
      'This permanently erases all tasks, lists, categories and settings on this device.',
      'Erase Everything', () => {
        db.clearAll();
        location.reload();
      });
  });
}

/* ---------- one-time "what's your name?" sheet ----------
   No accounts: the greeting name is simply asked once inside the app
   (and can always be changed later in Profile). */

function openNamePrompt() {
  db.saveSettings({ namePromptSeen: true }); // ask only once
  const { sheet, close } = openSheet(`
    ${sheetHeader('Nice to meet you!')}
    <p class="muted" style="margin-bottom:16px">What should we call you?
      Your name is only used for the greeting and stays on this device.</p>
    <div class="field">
      <input id="np-name" class="input" placeholder="Your name" autocomplete="name" maxlength="40">
    </div>
    <button class="btn block" id="np-save">${icon('check', { size: 18 })}Save</button>
    <div class="spacer-8"></div>
    <button class="btn ghost block" id="np-skip">Maybe later</button>`);

  $('#np-save', sheet).addEventListener('click', () => {
    const name = $('#np-name', sheet).value.trim();
    if (name) db.saveSettings({ name });
    close();
    render();
    if (name) showToast(`${greetingWord()}, ${name}!`);
  });
  $('#np-skip', sheet).addEventListener('click', () => close());
  setTimeout(() => $('#np-name', sheet).focus(), 420);
}

/* ==========================================================================
   Boot
   ========================================================================== */

let appBooted = false;

/** Boots the app once the entry flow (welcome + slideshow) hands off. */
function bootApp() {
  document.body.dataset.screen = 'app';

  // the app starts empty — just an Inbox and the starter categories
  db.ensureDefaults();

  if (appBooted) return;
  appBooted = true;

  buildTabbar();

  const fab = $('#fab');
  fab.innerHTML = icon('plus', { size: 26, strokeWidth: 2.5 });
  fab.addEventListener('click', () => {
    if (!reducedMotion()) {
      fab.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(.84)' }, { transform: 'scale(1)' }],
        { duration: 280, easing: EASE_SPRING },
      );
    }
    openTaskSheet();
  });

  render();
  requestAnimationFrame(() => positionGlider(false));
  window.addEventListener('resize', () => positionGlider(false), { passive: true });

  // local reminder loop (see notifications.js for the closed-app limitation)
  notify.init(db.getTasks);

  // first entry: ask for a name so the greeting can say "Good evening, Jari"
  const s = db.getSettings();
  if (!s.name && !s.namePromptSeen) setTimeout(openNamePrompt, 650);
}

function init() {
  applyTheme(); // theme applies to the entry screens too

  // PWA: offline support + installability
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) =>
      console.warn('[sw] registration failed:', err));
  }

  // First launch: welcome + slideshow; afterwards straight into the app.
  entry.runEntryFlow({ onEnter: bootApp });
}

init();
