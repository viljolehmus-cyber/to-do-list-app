# Taskly — a premium mobile to-do PWA

A beautiful, colorful, offline-first to-do app built with **vanilla HTML, CSS and
JavaScript** — no frameworks, no build tools, no dependencies. Designed
exclusively for the phone (~390 px wide) with a native-app feel: bottom tab
bar, bottom sheets, gradient hero cards, smooth micro-interactions, and a dark
mode that looks just as good as the light theme.

All data lives in `localStorage` on your device. There is no backend and no
sync — open it and start checking things off.

## Features

**Entry flow**
- Polished **welcome** screen with **Log in** / **Sign up**
- **Local demo auth** — accounts are stored in `localStorage`; the session
  persists, so returning users skip straight to the app. ⚠️ This is demo
  auth, **not real security** (see `auth.js`).
- First-run **onboarding slideshow** — 10 swipeable, animated feature slides
  shown once per account; **Log out** lives in Settings

**Core**
- Add, edit and delete tasks (delete & complete come with **Undo**)
- Mark complete with a satisfying check animation

**Organization**
- Color-coded **categories** (Work, Home, Study, Health, Personal + your own)
- **Priorities** (high / medium / low), visually distinct
- **Lists (projects)** to group tasks, with an Inbox default
- **Search & filters** — by text, status, category, priority and due date

**Time**
- Due date and optional time per task
- **Local reminders** via the Notification API + service worker
  (true push to a *closed* app needs a backend, so reminders fire while the
  app is open or installed — see the comment in `notifications.js`)
- **Recurring tasks** (daily / weekly / monthly) — completing one
  automatically schedules the next occurrence

**Experience**
- Light & dark themes, saved per user and following the system setting
- Installable **PWA** that works fully offline
- **Stats** view: rounded bar chart, smooth line chart, day streak,
  completed-vs-open and per-category progress
- **Notes & image attachments** (stored as base64 in `localStorage`)
- **Smart suggestions** (rule-based, fully offline):
  - category suggested from keywords in the title
  - overdue / due-soon tasks surfaced in the bell panel and Today view
  - recurrence suggested when you keep completing the same task
  - a "Today" smart view that gathers the most relevant tasks
  - an optional, commented hook for future LLM-powered suggestions
    (`suggestions.js`, bottom of the file)
- Export / import your data as JSON from the Profile tab

## File structure

```
index.html        app shell (header, view container, tab bar, FAB, toast, #gate)
styles.css        design system: tokens, light/dark themes, components, entry flow
app.js            main controller: views, sheets, actions, charts, boot flow
storage.js        the only module touching task localStorage (+ sample data seed)
auth.js           local demo auth (accounts/session) — NOT real security
entry.js          welcome / login / sign-up + onboarding slideshow (DEV_MODE here)
suggestions.js    rule-based smart suggestions & date helpers
notifications.js  local reminder loop (Notification API)
icons.js          inline SVG icon system — icon('plus') returns an SVG string
manifest.json     PWA manifest
sw.js             service worker: pre-cached app shell, offline-first
icons/            generated PNG app icons
```

## Accounts, onboarding & the dev shortcut

- **Sign up / log in** are handled entirely on-device by `auth.js`. Accounts
  (name, email, lightly-hashed password) and the current session live in
  `localStorage`. This is a realistic *demo* of an auth flow — it is **not
  secure** and must never be used for real credentials. The limitation is
  documented at the top of `auth.js`.
- **Onboarding** runs once per account. The `onboardingSeen` flag is stored
  on the account, so returning logins go straight to the app.
- **Dev shortcut:** the welcome screen shows a **"Skip (dev) → Demo
  account"** button that logs into a pre-made demo account and always
  replays the onboarding (handy for previewing it). It's gated behind
  `const DEV_MODE = true;` at the top of `entry.js` — set it to `false`
  (or delete the button) before a real release.

Flow on launch: no user → welcome; logged-in but not onboarded → onboarding;
logged-in and onboarded → straight into the app.

## Run locally

ES modules and service workers need an HTTP server (opening `index.html`
via `file://` won't work). Any static server does:

```bash
# from the project root — then open http://localhost:8000 on your phone
# or in a browser with mobile emulation (~390px wide)
python3 -m http.server 8000
```

Tip: in Chrome DevTools, toggle the device toolbar and pick *iPhone 14 Pro*.

## Deploy to GitHub Pages

The app uses **relative paths everywhere**, so it works from a subdirectory
out of the box:

1. Push this repository to GitHub.
2. Repo **Settings → Pages → Source**: deploy from branch, select your branch
   and `/ (root)`.
3. Open `https://<username>.github.io/<repo>/` on your phone and
   **Add to Home Screen** to install it as an app.

After changing any file, bump `VERSION` in `sw.js` so installed clients fetch
the new assets.

## Notes & limitations

- **Storage**: `localStorage` holds ~5 MB. Image attachments are downscaled
  to ≤1280px and re-encoded as JPEG before being stored as base64, so even
  large photos stay small and saves never block the main thread.
- **Notifications**: reminders fire while the app is open (tab or installed
  PWA). Real push notifications to a closed app require a Web Push backend,
  which is intentionally out of scope for this no-backend app.
- **Reset**: Profile → Reset app erases everything and re-seeds the sample
  data on next launch.
