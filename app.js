/* ==========================================================================
   app.js — Taskly main controller.

   Owns UI state, renders the four tabs (Today / Tasks / Stats / Profile),
   and wires up bottom sheets, the FAB, toasts with undo, charts and theme
   switching. All persistence goes through storage.js; all "smart" logic
   lives in suggestions.js.
   ========================================================================== */

import { icon } from './icons.js';
import * as db from './storage.js';
import * as smart from './suggestions.js';
import * as notify from './notifications.js';

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
};

function activeFilterCount() {
  const f = state.filters;
  return (f.status !== 'all') + (f.category !== null) + (f.priority !== null) + (f.due !== 'any');
}

/* ==========================================================================
   Root render & tab bar
   ========================================================================== */

const TABS = [
  { id: 'today',   label: 'Today',   icon: 'sun'   },
  { id: 'tasks',   label: 'Tasks',   icon: 'list'  },
  { id: 'stats',   label: 'Stats',   icon: 'chart' },
  { id: 'profile', label: 'Profile', icon: 'user'  },
];

function render() {
  const view = $('#view');
  view.className = 'view';
  if (state.tab === 'today') renderToday(view);
  else if (state.tab === 'tasks') renderTasks(view);
  else if (state.tab === 'stats') renderStats(view);
  else renderProfile(view);
  // restart the view entrance animation
  view.style.animation = 'none';
  void view.offsetHeight;
  view.style.animation = '';
  renderTabbar();
}

function renderTabbar() {
  $('#tabbar').innerHTML = TABS.map((t) => `
    <button class="tab ${state.tab === t.id ? 'active' : ''}" data-tab="${t.id}">
      <span class="ind">${icon(t.icon, { size: 22 })}</span>${t.label}
    </button>`).join('');
  $$('#tabbar .tab').forEach((b) =>
    b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); }));
}

function switchTab(tab) { state.tab = tab; render(); }

/* ==========================================================================
   Task row component
   ========================================================================== */

function categoryOf(task) {
  return task.category ? db.getCategory(task.category) : null;
}

function taskRowHTML(task, i = 0) {
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
    <div class="task-row ${task.completed ? 'done' : ''}" data-id="${task.id}"
         style="animation-delay:${Math.min(i * 35, 280)}ms" role="button" tabindex="0">
      <button class="check ${task.completed ? 'checked' : ''}" aria-label="Toggle complete"
              style="${checkColor ? `--check-c:${checkColor}` : ''}">${icon('check', { size: 15, strokeWidth: 3 })}</button>
      <div class="task-main">
        <div class="task-title">${esc(task.title)}</div>
        ${chips.length ? `<div class="task-meta">${chips.join('')}</div>` : ''}
      </div>
      ${icon('chevron-right', { size: 19, cls: 'chevron' })}
    </div>`;
}

/** Attach check / open handlers to all task rows inside `root`. */
function bindTaskRows(root) {
  $$('.task-row', root).forEach((row) => {
    const id = row.dataset.id;
    $('.check', row).addEventListener('click', (e) => {
      e.stopPropagation();
      toggleComplete(id, row);
    });
    row.addEventListener('click', () => openDetailSheet(id));
  });
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

function toggleComplete(id, rowEl) {
  const task = db.getTask(id);
  if (!task) return;

  if (!task.completed) {
    // play the check + fade animation before re-rendering
    if (rowEl) {
      $('.check', rowEl).classList.add('checked');
      rowEl.classList.add('completing');
    }
    setTimeout(() => {
      task.completed = true;
      task.completedAt = new Date().toISOString();
      db.saveTask(task);

      // automation: recurring tasks immediately spawn their next occurrence
      let next = null;
      if (task.recurrence) {
        next = createNextOccurrence(task);
        db.saveTask(next);
      }
      render();
      showToast(
        next ? `Done! Next one ${fmtDueLabel(next).toLowerCase()}` : 'Task completed',
        {
          undo: () => {
            task.completed = false;
            task.completedAt = null;
            db.saveTask(task);
            if (next) db.deleteTask(next.id);
            render();
          },
        },
      );
    }, rowEl ? 420 : 0);
  } else {
    task.completed = false;
    task.completedAt = null;
    db.saveTask(task);
    render();
  }
}

function deleteTaskWithUndo(id) {
  const copy = db.getTask(id);
  if (!copy) return;
  db.deleteTask(id);
  render();
  showToast('Task deleted', {
    undo: () => { db.saveTask(copy); render(); },
  });
}

/* ==========================================================================
   Toast (with undo)
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
   Bottom sheets — generic helper
   ========================================================================== */

function openSheet(html) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `<div class="sheet-handle"></div>${html}`;
  document.body.append(backdrop, sheet);
  requestAnimationFrame(() => {
    backdrop.classList.add('show');
    sheet.classList.add('show');
  });

  const close = () => {
    backdrop.classList.remove('show');
    sheet.classList.remove('show');
    setTimeout(() => { backdrop.remove(); sheet.remove(); }, 360);
  };
  backdrop.addEventListener('click', close);
  $('.sheet-close', sheet)?.addEventListener('click', close);
  return { sheet, close };
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
  $('#cf-no', sheet).addEventListener('click', close);
}

/* ==========================================================================
   Task form sheet (add & edit)
   ========================================================================== */

function reminderOffsetMinutes(task) {
  if (!task?.reminderAt || !task?.dueDate) return '';
  const diff = Math.round((smart.dueDateTime(task) - new Date(task.reminderAt)) / 60000);
  return [0, 10, 60, 1440].includes(diff) ? String(diff) : '';
}

function openTaskSheet(existing = null, defaults = {}) {
  const isEdit = !!existing;
  const categories = db.getCategories();
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
  $('#tf-file', sheet).addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // Images are stored as base64 in localStorage (~5MB quota) — keep them small.
    if (file.size > 1.5 * 1024 * 1024) {
      showToast('Image too large — please pick one under 1.5 MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      sel.attachments.push({ id: db.uid(), name: file.name, dataUrl: reader.result });
      renderThumbs();
    };
    reader.readAsDataURL(file);
    e.target.value = '';
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
    render();
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
        <div class="task-row" data-pick="${p.id}" style="animation:none">
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
    state.tab = 'tasks';
    close();
    render();
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
    state.tab = 'tasks';
    close();
    render();
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
    render();
  });
  $('#fl-apply', sheet).addEventListener('click', () => {
    state.filters = draft;
    close();
    render();
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
      <div class="task-list" id="bl-overdue">${overdue.map((t, i) => taskRowHTML(t, i)).join('')}</div>` : ''}
    ${dueSoon.length ? `
      <div class="section-head"><h2>${icon('clock', { size: 18 })} Due soon</h2>
        <span class="count">${dueSoon.length}</span></div>
      <div class="task-list" id="bl-soon">${dueSoon.map((t, i) => taskRowHTML(t, i)).join('')}</div>` : ''}
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
  // open task details from inside the sheet
  $$('.task-row', sheet).forEach((row) => {
    $('.check', row).addEventListener('click', (e) => {
      e.stopPropagation();
      close();
      toggleComplete(row.dataset.id, null);
    });
    row.addEventListener('click', () => { close(); openDetailSheet(row.dataset.id); });
  });
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
  const tasks = db.getTasks();
  const { overdue, today, suggested, doneToday } = smart.buildToday(tasks);
  const name = db.getSettings().name.trim();
  const openToday = today.length;
  const totalToday = openToday + doneToday.length;
  const pct = totalToday ? Math.round((doneToday.length / totalToday) * 100) : 0;
  const hasAlerts = overdue.length + smart.getDueSoonTasks(tasks).length > 0;
  const dateLabel = new Date().toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric' });
  const nothingOpen = !overdue.length && !openToday && !suggested.length;

  view.innerHTML = `
    <div class="topbar">
      <div>
        <div class="greeting-sub">${dateLabel}</div>
        <div class="greeting">${greetingWord()}${name ? `, ${esc(name)}` : ''}</div>
      </div>
      <div class="topbar-actions">
        <button class="icon-btn" id="td-bell" aria-label="Notifications">
          ${icon('bell', { size: 20 })}${hasAlerts ? '<span class="alert-dot"></span>' : ''}
        </button>
        <div class="avatar">${name ? esc(name[0].toUpperCase()) : icon('user', { size: 20 })}</div>
      </div>
    </div>

    <button class="searchbar" id="td-search" style="width:100%">
      ${icon('search', { size: 19 })}<span style="color:var(--text-3);font-size:16px">Search tasks…</span>
    </button>

    <div class="hero-card">
      <div class="hero-kicker">Today's progress</div>
      <div class="hero-title">${
        nothingOpen && !totalToday ? 'A fresh start.<br>Plan something great.' :
        openToday === 0 && totalToday > 0 ? 'All done for today.<br>You crushed it!' :
        `You have <br>${openToday + overdue.length} task${openToday + overdue.length === 1 ? '' : 's'} to go`}</div>
      <div class="hero-stats">
        <div class="hero-stat"><div class="n">${doneToday.length}</div><div class="l">Done</div></div>
        <div class="hero-stat"><div class="n">${openToday}</div><div class="l">Open today</div></div>
        <div class="hero-stat"><div class="n">${overdue.length}</div><div class="l">Overdue</div></div>
      </div>
      <div class="progressbar"><i style="width:${pct}%"></i></div>
    </div>

    ${overdue.length ? `
      <div class="section-head"><h2>Overdue</h2><span class="count">${overdue.length}</span></div>
      <div class="task-list" id="td-overdue">${overdue.map((t, i) => taskRowHTML(t, i)).join('')}</div>` : ''}

    ${openToday ? `
      <div class="section-head"><h2>Today</h2><span class="count">${openToday}</span></div>
      <div class="task-list" id="td-today">${today.map((t, i) => taskRowHTML(t, i)).join('')}</div>` : ''}

    ${suggested.length ? `
      <div class="section-head"><h2>${icon('sparkles', { size: 17 })} Up next</h2>
        <button class="link" id="td-all">See all</button></div>
      <div class="task-list" id="td-suggested">${suggested.map((t, i) => taskRowHTML(t, i)).join('')}</div>` : ''}

    ${nothingOpen ? `
      <div class="spacer-16"></div>
      <div class="empty-card">
        <div class="ring">${icon('sparkles', { size: 28 })}</div>
        <h3>You're all caught up</h3>
        <p>No urgent tasks right now. Add something new or enjoy the calm.</p>
        <div class="spacer-16"></div>
        <button class="btn gradient" id="td-add">${icon('plus', { size: 17 })}New Task</button>
      </div>` : ''}

    ${doneToday.length ? `
      <div class="section-head"><h2>Done today</h2><span class="count">${doneToday.length}</span></div>
      <div class="task-list" id="td-done">${doneToday.slice(0, 5).map((t, i) => taskRowHTML(t, i)).join('')}</div>` : ''}`;

  bindTaskRows(view);
  $('#td-bell', view).addEventListener('click', openBellSheet);
  $('#td-search', view).addEventListener('click', () => {
    switchTab('tasks');
    setTimeout(() => $('#ts-search')?.focus(), 80);
  });
  $('#td-all', view)?.addEventListener('click', () => switchTab('tasks'));
  $('#td-add', view)?.addEventListener('click', () => openTaskSheet(null, { dueDate: smart.todayStr() }));
}

/* ==========================================================================
   View: Tasks
   ========================================================================== */

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
      <button class="filter-btn ${activeFilterCount() ? 'on' : ''}" id="ts-filter" aria-label="Filters">
        ${icon('sliders', { size: 20 })}
        ${activeFilterCount() ? `<span class="count">${activeFilterCount()}</span>` : ''}
      </button>
    </div>

    <div class="pill-row" id="ts-projects">
      <button class="pill ${state.projectId === null ? 'active' : ''}" data-proj="">All</button>
      ${projects.map((p) => `
        <button class="pill c-${p.color} ${state.projectId === p.id ? 'active' : ''}" data-proj="${p.id}">
          <span class="dot c-${p.color}"></span>${esc(p.name)}</button>`).join('')}
      <button class="pill" id="ts-lists">${icon('plus', { size: 14 })}List</button>
    </div>

    <div id="ts-area"></div>`;

  function renderListArea() {
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

    $('#ts-sub').textContent = `${open.length} open · ${done.length} completed`;

    const area = $('#ts-area', view);
    area.innerHTML = `
      ${open.length ? `<div class="task-list">${open.map((t, i) => taskRowHTML(t, i)).join('')}</div>` : `
        <div class="empty-card">
          <div class="ring">${icon('inbox', { size: 28 })}</div>
          <h3>${state.search || activeFilterCount() ? 'No matching tasks' : 'Nothing here yet'}</h3>
          <p>${state.search || activeFilterCount()
            ? 'Try changing your search or filters.'
            : 'Tap the + button to add your first task.'}</p>
        </div>`}
      ${done.length ? `
        <div class="section-head">
          <h2>Completed</h2>
          <button class="link" id="ts-toggle-done">${state.showCompleted ? 'Hide' : `Show (${done.length})`}</button>
        </div>
        ${state.showCompleted ? `<div class="task-list">${done.map((t, i) => taskRowHTML(t, i)).join('')}</div>` : ''}` : ''}`;

    bindTaskRows(area);
    $('#ts-toggle-done', area)?.addEventListener('click', () => {
      state.showCompleted = !state.showCompleted;
      renderListArea();
    });
  }
  renderListArea();

  // live search re-renders only the list, keeping the input focused
  $('#ts-search', view).addEventListener('input', debounce((e) => {
    state.search = e.target.value;
    renderListArea();
  }, 180));

  $('#ts-filter', view).addEventListener('click', openFiltersSheet);
  $('#ts-lists', view).addEventListener('click', openListsSheet);
  $$('#ts-projects [data-proj]', view).forEach((b) => b.addEventListener('click', () => {
    state.projectId = b.dataset.proj || null;
    render();
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

/* --- chart builders (pure SVG, no libraries) --- */

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
            rx="${Math.min(9, barW / 2)}" fill="${color}">
        <animate attributeName="height" from="0" to="${h.toFixed(1)}" dur="0.5s" fill="freeze"/>
        <animate attributeName="y" from="${H - bottom}" to="${y.toFixed(1)}" dur="0.5s" fill="freeze"/>
      </rect>
      ${d.count ? `<text class="bar-value" x="${(x + barW / 2).toFixed(1)}" y="${(y - 7).toFixed(1)}" text-anchor="middle">${d.count}</text>` : ''}
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
    <path d="${path}" fill="none" stroke="url(#lc-stroke)" stroke-width="3" stroke-linecap="round"/>
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
  const catRows = categories.map((c, i) => {
    const catTasks = tasks.filter((t) => t.category === c.id);
    if (!catTasks.length) return '';
    const completed = catTasks.filter((t) => t.completed).length;
    const pct = Math.round((completed / catTasks.length) * 100);
    return `
      <div class="row" style="animation:rowIn .3s ${i * 50}ms backwards">
        <div class="top">
          <span class="name"><span class="dot c-${c.color}"></span>${esc(c.name)}</span>
          <span class="pct">${completed}/${catTasks.length} · ${pct}%</span>
        </div>
        <div class="progressbar subtle"><i style="width:${pct}%;background:${COLOR_HEX[c.color]}"></i></div>
      </div>`;
  }).join('');

  view.innerHTML = `
    <h1 class="page-title">Your <span class="light">progress</span></h1>
    <p class="subtitle">Keep the momentum going</p>
    <div class="spacer-16"></div>

    <div class="hero-card cool">
      <div class="hero-kicker">This week</div>
      <div class="hero-title">${doneThisWeek} task${doneThisWeek === 1 ? '' : 's'} completed</div>
      <div class="hero-sub">${rate}% of everything on your plate is done</div>
      <div class="progressbar"><i style="width:${rate}%"></i></div>
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
        <div class="grow">Taskly v1.0
          <span class="sub">Offline-first PWA · your data never leaves this device</span>
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

/* ==========================================================================
   Boot
   ========================================================================== */

function init() {
  db.ensureSeed();
  applyTheme();

  $('#fab').innerHTML = icon('plus', { size: 26, strokeWidth: 2.5 });
  $('#fab').addEventListener('click', () => openTaskSheet());

  render();

  // local reminder loop (see notifications.js for the closed-app limitation)
  notify.init(db.getTasks);

  // PWA: offline support + installability
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) =>
      console.warn('[sw] registration failed:', err));
  }
}

init();
