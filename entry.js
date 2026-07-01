/* ==========================================================================
   entry.js — the "in front of the app" experience:
     • A welcome screen with a single "Get Started" button (no accounts —
       everything lives on this device)
     • First-run onboarding slideshow (10 animated feature slides)

   Shown only until the slideshow has been seen once (settings.onboardingSeen);
   after that, launches go straight into the app. It mounts into #gate (a
   full-screen layer above the app) and calls onEnter() to hand control to
   the real app.
   ========================================================================== */

import { icon } from './icons.js';
import * as db from './storage.js';

const EASE_OUT = 'cubic-bezier(.22, 1, .36, 1)';
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const COLORS = ['#5B6CFF', '#FF4D8D', '#19C68C', '#FF9D42', '#9D6BFF', '#FFC940'];

let mount;       // the #gate element
let onEnterApp;  // callback into app.js to boot the real app

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ==========================================================================
   Flow
   ========================================================================== */

/** First launch → welcome + slideshow; afterwards → straight into the app. */
export function runEntryFlow({ onEnter }) {
  onEnterApp = onEnter;
  mount = document.getElementById('gate');
  mount.hidden = false;
  document.body.dataset.screen = 'entry';

  if (db.getSettings().onboardingSeen) finish();
  else showWelcome();
}

/** Hand off to the app: reveal it underneath, then fade the gate away. */
function finish() {
  document.body.dataset.screen = 'app';
  onEnterApp();
  if (reduce()) { teardown(); return; }
  requestAnimationFrame(() => {
    const a = mount.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: EASE_OUT });
    a.onfinish = teardown;
  });
}
function teardown() { mount.innerHTML = ''; mount.hidden = true; }

/* ==========================================================================
   Screen transitions (welcome → onboarding inside the gate)
   ========================================================================== */

/** Build a new .gate-screen via `build(el)`, slide it in, slide old out. */
function transitionTo(build, dir = 1) {
  const old = mount.querySelector('.gate-screen');
  const next = document.createElement('div');
  next.className = 'gate-screen';
  build(next);
  mount.appendChild(next);

  if (reduce() || !old) { old?.remove(); return next; }
  next.animate(
    [{ opacity: 0, transform: `translateX(${26 * dir}px)` }, { opacity: 1, transform: 'none' }],
    { duration: 300, easing: EASE_OUT },
  );
  const a = old.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-26 * dir}px)` }],
    { duration: 230, easing: 'ease-in' },
  );
  a.onfinish = () => old.remove();
  return next;
}

/* ==========================================================================
   Welcome screen — one big button, no accounts
   ========================================================================== */

function showWelcome() {
  transitionTo((el) => {
    el.innerHTML = `
      <div class="welcome">
        <div class="welcome-hero">
          <div class="brand-mark">${icon('check', { size: 56, strokeWidth: 3 })}</div>
          <div class="brand-name">Taskly</div>
        </div>

        <div class="welcome-body">
          <h1 class="welcome-title">Get things done,<br><span>beautifully.</span></h1>
          <p class="welcome-sub">Plan your day, organize everything with colorful
            categories, and build momentum — all in one calm place.</p>

          <button class="btn gradient block" id="w-start">${icon('sparkles', { size: 18 })}Get Started</button>

          <p class="demo-note">${icon('shield', { size: 13 })}No account needed — your tasks
            stay private on this device.</p>
        </div>
      </div>`;

    el.querySelector('#w-start').addEventListener('click', () => showOnboarding());
  }, -1);
}

/* ==========================================================================
   Onboarding slideshow
   ========================================================================== */

/* Small illustration helpers, built from the same components as the app
   (cards, pills, meta-chips, progress bars) so they look native. */

const drawCheck = (size = 30) => `
  <svg class="draw" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path pathLength="1" d="M20 6 9 17l-5-5"/></svg>`;

const badge = (grad, ic, cls = '') => `
  <div class="il-badge ${grad} pop ${cls}">${ic}</div>`;

const miniRow = (cls, title, right = '', checked = false) => `
  <div class="il-row ${cls}">
    <span class="il-check ${checked ? 'on' : ''}">${checked ? drawCheck(16) : ''}</span>
    <span class="il-row-title">${esc(title)}</span>
    ${right}
  </div>`;

const SLIDES = [
  {
    key: 'welcome',
    heading: 'Welcome to Taskly',
    desc: 'Your beautiful, private home for getting things done — entirely on your device.',
    art: () => `
      <div class="il il-welcome">
        ${badge('grad-hero', drawCheck(46))}
      </div>`,
  },
  {
    key: 'add',
    heading: 'Add tasks in seconds',
    desc: 'Tap the + button anywhere to capture what’s on your mind before it slips away.',
    art: () => `
      <div class="il il-add">
        ${miniRow('rise d1', 'Buy groceries')}
        ${miniRow('rise d2 ', 'Morning run', '', true)}
        ${miniRow('rise d3', 'Call the dentist')}
        <div class="il-fab pop">${icon('plus', { size: 26, strokeWidth: 2.5 })}</div>
      </div>`,
  },
  {
    key: 'categories',
    heading: 'Organize with color',
    desc: 'Sort tasks into bold, color-coded categories and lists you create yourself.',
    art: () => `
      <div class="il il-pills">
        <span class="pill active c-blue pop d1"><span class="dot c-blue"></span>Work</span>
        <span class="pill active c-orange pop d2"><span class="dot c-orange"></span>Home</span>
        <span class="pill active c-purple pop d3"><span class="dot c-purple"></span>Study</span>
        <span class="pill active c-mint pop d4"><span class="dot c-mint"></span>Health</span>
        <span class="pill active c-pink pop d5"><span class="dot c-pink"></span>Personal</span>
      </div>`,
  },
  {
    key: 'priority',
    heading: 'Set what matters most',
    desc: 'Flag tasks high, medium or low so the important things always stand out.',
    art: () => `
      <div class="il il-prios">
        <div class="il-prio rise d1"><span class="meta-chip c-red">${icon('flag', { size: 13 })}High</span><i style="background:var(--red)"></i></div>
        <div class="il-prio rise d2"><span class="meta-chip c-orange">${icon('flag', { size: 13 })}Medium</span><i style="background:var(--orange)"></i></div>
        <div class="il-prio rise d3"><span class="meta-chip c-mint">${icon('flag', { size: 13 })}Low</span><i style="background:var(--mint)"></i></div>
      </div>`,
  },
  {
    key: 'due',
    heading: 'Due dates & reminders',
    desc: 'Give tasks a deadline and a nudge, so nothing important catches you off guard.',
    art: () => `
      <div class="il il-due">
        ${badge('soft-blue', icon('calendar', { size: 44 }))}
        <div class="il-bell ring">${icon('bell', { size: 30 })}<span class="il-bell-dot"></span></div>
      </div>`,
  },
  {
    key: 'recurring',
    heading: 'Tasks that repeat',
    desc: 'Make a task daily, weekly or monthly — finish one and the next appears automatically.',
    art: () => `
      <div class="il il-recur">
        <div class="il-spin spin">${icon('repeat', { size: 56 })}</div>
        ${miniRow('rise d2', 'Water the plants',
          `<span class="meta-chip c-purple">${icon('repeat', { size: 12 })}Daily</span>`, true)}
      </div>`,
  },
  {
    key: 'search',
    heading: 'Find anything fast',
    desc: 'Search by text and filter by category, priority, status or due date in a tap.',
    art: () => `
      <div class="il il-search">
        <div class="il-searchbar pop">
          <span class="ic">${icon('search', { size: 20 })}</span>
          <span class="q">read</span>
        </div>
        ${miniRow('match rise d1', 'Read a book')}
        ${miniRow('nomatch', 'Buy groceries')}
        ${miniRow('match rise d3', 'Read the news')}
      </div>`,
  },
  {
    key: 'progress',
    heading: 'Watch your progress',
    desc: 'Colorful charts and a daily streak keep your momentum visible and rewarding.',
    art: () => `
      <div class="il il-progress">
        <div class="il-bars">
          ${[34, 18, 30, 48, 26, 40, 52].map((h, i) =>
            `<span class="il-bar grow" style="height:${h}px;background:${COLORS[i % COLORS.length]};animation-delay:${i * 70}ms"></span>`).join('')}
        </div>
        <div class="il-streak pop">${badge('grad-mint', icon('flame', { size: 26 }))}
          <div class="il-streak-t"><b>5</b> day streak</div></div>
      </div>`,
  },
  {
    key: 'theme',
    heading: 'Light & dark, both gorgeous',
    desc: 'A bright, airy light theme and a deep, vivid dark theme — your call, any time.',
    art: () => `
      <div class="il il-theme">
        <div class="il-mini light pop d1">
          <div class="il-mini-hero" style="background:var(--grad-hero)"></div>
          <div class="il-mini-bar"></div><div class="il-mini-bar short"></div>
          <span class="il-mini-ic">${icon('sun', { size: 18 })}</span>
        </div>
        <div class="il-mini dark pop d2">
          <div class="il-mini-hero" style="background:var(--grad-cool)"></div>
          <div class="il-mini-bar"></div><div class="il-mini-bar short"></div>
          <span class="il-mini-ic">${icon('moon', { size: 18 })}</span>
        </div>
      </div>`,
  },
  {
    key: 'smart',
    heading: 'Smart suggestions',
    desc: 'Taskly suggests categories and recurrence as you type — all offline. You’re set!',
    art: () => `
      <div class="il il-smart">
        ${badge('grad-cool', icon('sparkles', { size: 40 }))}
        <div class="suggest-chip rise d1">${icon('sparkles', { size: 14 })}Category: Work</div>
        <div class="suggest-chip rise d2">${icon('repeat', { size: 14 })}Repeat weekly?</div>
      </div>`,
  },
];

function showOnboarding() {
  const total = SLIDES.length;
  const st = { i: 0, w: 0 };

  transitionTo((el) => {
    el.innerHTML = `
      <div class="onb">
        <div class="onb-top">
          <button class="onb-skip" id="onb-skip">Skip</button>
        </div>
        <div class="onb-track" id="onb-track">
          ${SLIDES.map((s, i) => `
            <section class="onb-slide ${i === 0 ? 'in' : ''}" data-i="${i}">
              <div class="onb-art">${s.art()}</div>
              <h2>${esc(s.heading)}</h2>
              <p>${esc(s.desc)}</p>
            </section>`).join('')}
        </div>
        <div class="onb-foot">
          <div class="onb-dots" id="onb-dots">
            ${SLIDES.map((_, i) => `<span class="onb-dot ${i === 0 ? 'active' : ''}"></span>`).join('')}
          </div>
          <div class="onb-nav">
            <button class="onb-back" id="onb-back">${icon('chevron-left', { size: 18 })}Back</button>
            <button class="btn" id="onb-next">Next${icon('arrow-right', { size: 18 })}</button>
          </div>
        </div>
      </div>`;

    const track = el.querySelector('#onb-track');
    const slides = [...el.querySelectorAll('.onb-slide')];
    const dots = [...el.querySelectorAll('.onb-dot')];
    const back = el.querySelector('#onb-back');
    const next = el.querySelector('#onb-next');

    const setTrack = (px, animate) => {
      track.style.transition = (animate && !reduce()) ? `transform .2s ${EASE_OUT}` : 'none';
      track.style.transform = `translateX(${px}px)`;
    };

    function go(i, animate = true) {
      st.i = Math.max(0, Math.min(total - 1, i));
      st.w = slides[0].getBoundingClientRect().width; // one slide = one viewport
      setTrack(-st.i * st.w, animate);
      dots.forEach((d, k) => d.classList.toggle('active', k === st.i));
      slides.forEach((s, k) => s.classList.toggle('in', k === st.i));
      back.classList.toggle('hidden', st.i === 0);
      const last = st.i === total - 1;
      next.innerHTML = last
        ? `${icon('check', { size: 18 })}Get Started`
        : `Next${icon('arrow-right', { size: 18 })}`;
      next.classList.toggle('gradient', last);
    }

    function done() {
      db.saveSettings({ onboardingSeen: true });
      finish();
    }

    el.querySelector('#onb-skip').addEventListener('click', done);
    back.addEventListener('click', () => go(st.i - 1));
    next.addEventListener('click', () => (st.i === total - 1 ? done() : go(st.i + 1)));

    // Navigation is via the Back / Next buttons only (no swipe gesture).
    // position once layout is ready
    requestAnimationFrame(() => go(0, false));
  }, 1);
}
