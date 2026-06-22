# Taskly — backend setup (Supabase)

Taskly runs as a static site (great for GitHub Pages) but uses **Supabase**
for real accounts and a private, per-user cloud database. Until you complete
the steps below, the app runs in **local mode** (accounts and data stay on the
device) so it keeps working — but it is not "real" until you connect Supabase.

You only need a free Supabase account. No servers, no build step.

---

## 1. Create a Supabase project

1. Go to <https://supabase.com> → **New project**.
2. Pick a name, a strong database password, and a region near your users.
3. Wait ~2 minutes for it to provision.

## 2. Create the tables + security (copy‑paste SQL)

Open **SQL Editor → New query**, paste **all** of the following, and click
**Run**. It creates the four tables, turns on Row‑Level Security with a policy
that lets each user touch only their own rows, adds the account‑deletion
function, and enables realtime.

```sql
-- ============================ TABLES ============================
-- Each entity is one row tied to a user. The JSON document keeps the app's
-- flexible shape (attachments, recurrence, etc.) without a rigid schema.

create table if not exists public.tasks (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  id         text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.projects (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  id         text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.categories (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  id         text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.settings (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  data       jsonb       not null,
  updated_at timestamptz not null default now()
);

-- ===================== ROW-LEVEL SECURITY ======================
-- This is what actually keeps data private. With RLS on, the public anon
-- key shipped in the browser can ONLY read/write rows where user_id equals
-- the signed-in user's id. The client is never trusted for ownership.

alter table public.tasks      enable row level security;
alter table public.projects   enable row level security;
alter table public.categories enable row level security;
alter table public.settings   enable row level security;

create policy "own tasks"      on public.tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own projects"   on public.projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own categories" on public.categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own settings"   on public.settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ==================== DELETE-ACCOUNT RPC =======================
-- Lets a signed-in user delete THEIR OWN account. SECURITY DEFINER runs it
-- as the function owner (postgres) so it can remove the auth user; the
-- on-delete-cascade above then wipes all of that user's rows.

create or replace function public.delete_user()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.users where id = auth.uid();
$$;

revoke all on function public.delete_user() from public, anon;
grant execute on function public.delete_user() to authenticated;

-- ===================== REALTIME (optional) =====================
-- Lets changes on one device show up live on another. Safe to skip.
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.projects;
alter publication supabase_realtime add table public.categories;
```

> If you re-run the script and a `create policy` line errors with "already
> exists", that policy is already in place — you can ignore it or
> `drop policy "own tasks" on public.tasks;` first.

## 3. Turn on email auth (with confirmation)

1. **Authentication → Providers → Email**: make sure it's **enabled**.
2. Keep **Confirm email** **on** (the default). New users get a confirmation
   link before they can log in — Taskly shows a "Confirm your email" screen
   for this.

## 4. (Optional) Continue with Google

1. **Authentication → Providers → Google** → enable it.
2. Create an OAuth client in the Google Cloud console and paste the **Client
   ID / Secret** into Supabase.
3. In Google, add Supabase's callback URL (shown on that Supabase page,
   `https://<your-project>.supabase.co/auth/v1/callback`) as an authorized
   redirect URI.

The "Continue with Google" button appears automatically once Supabase is
configured.

## 5. Allow your site as a redirect URL

**Authentication → URL Configuration**:

- **Site URL:** your deployed app URL, e.g.
  `https://<your-github-username>.github.io/<your-repo>/`
- **Redirect URLs:** add the **exact** same URL (trailing slash included):
  ```
  https://<your-github-username>.github.io/<your-repo>/
  ```
  For local testing also add, e.g. `http://localhost:8000/`.

These must match where the app is served, or email confirmation / password
reset / Google sign-in links won't be allowed to return to your app.

## 6. Paste your keys into `config.js`

In Supabase: **Project Settings → API**. Copy the **Project URL** and the
**anon public** key, then edit `config.js`:

```js
export const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
```

- The **anon public** key is meant for the browser — it's safe **because RLS
  is enabled**.
- ⚠️ **Never** paste the **`service_role`** (secret) key here or anywhere in
  the client. It bypasses RLS and would expose everyone's data.
- Leave `DEV_MODE = false` for production.

## 7. Deploy to GitHub Pages

1. Commit and push (the app uses relative paths, so a subdirectory is fine).
2. **Repo → Settings → Pages → Source:** deploy from your branch, `/ (root)`.
3. Open `https://<your-username>.github.io/<your-repo>/` on your phone and
   **Add to Home Screen**.

After changing any file, bump `VERSION` in `sw.js` so installed devices pick
up the new assets.

---

## How it stays offline-first

- The UI always reads from a local cache, so it's instant even on a flaky
  connection.
- Writes apply immediately (optimistic) and are queued; `sync.js` flushes the
  queue to Postgres and re-pulls on login. A small status pill shows
  **Syncing / Offline / Sync paused** when relevant.
- Make changes on a plane, land, and they sync up automatically.

## Updating the vendored client

The Supabase browser client is vendored at `vendor/supabase.js` (no CDN, so
the PWA works offline). To update it:

```bash
npm pack @supabase/supabase-js@2
tar xzf supabase-supabase-js-*.tgz package/dist/umd/supabase.js
cp package/dist/umd/supabase.js vendor/supabase.js
# then bump VERSION in sw.js
```

## Security checklist

- [x] RLS enabled on every table with `auth.uid() = user_id` policies.
- [x] Only the **anon public** key is in the client; never `service_role`.
- [x] Account deletion runs through a `security definer` function scoped to
      the caller (`auth.uid()`), not a client-side delete.
- [x] Validation happens in the database (RLS + constraints), not just the UI.
