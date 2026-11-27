# My Life OS — Cloud sync setup (Supabase)

## What's in the folder

```
my-life-os/
├── index.html              ← the whole app
├── sw.js                   ← service worker (offline + install)
├── manifest.webmanifest    ← app name, colours, icons
├── icons/                  ← placeholder logo (replace with yours, see below)
└── supabase.sql            ← run once in Supabase (not needed on the website)
```

`index.html` still runs on its own, for example opened as a file. It just can't be installed or work offline that way. To get the app experience, host the whole folder on https.

Cloud sync is optional. Without it, the app works exactly as before: everything stays in this browser's IndexedDB. With it, IndexedDB is still the main store (fast and offline-first), and your own Supabase project keeps a copy that syncs across your devices.

## 1. Create a free Supabase project

1. Sign up at <https://supabase.com> and click **New project**.
2. Choose a name (e.g. `my-life-os`), set a strong **database password** (you won't need it in the app), and pick the region closest to you (e.g. *Mumbai*).
3. Wait about 2 minutes for the project to finish setting up.

## 2. Run the SQL

1. In the dashboard, open **SQL Editor → New query**.
2. Paste the whole of `supabase.sql` and click **Run**. It is safe to run again.

The script creates:

- the `records` table
- an index on `(user_id, server_updated_at)`
- a trigger that stamps `server_updated_at` on every write. It also skips any write that carries an older `updated_at` than the stored row, so an offline device can't overwrite a newer edit.
- Row Level Security policies, so a signed-in user can only select, insert, update or delete their own rows. The `anon` role has no access at all.

To check it worked, open **Table Editor → records**. The table should be there, labelled *RLS enabled*.

## 3. Auth settings

Under **Authentication** in the dashboard:

| Setting | Where | Value |
|---|---|---|
| Email provider | Authentication → Sign In / Providers → **Email** | Enabled (it is by default). |
| Confirm email | Same page | **On** (recommended): new accounts must click the link in an email before they can sign in. If you turn it off, *Create account* signs you in immediately. |
| Site URL | Authentication → **URL Configuration** | The https address where you host the app, e.g. `https://yourname.github.io/my-life-os/` |
| Redirect URLs | Same page → *Add URL* | The same address again. Add `http://localhost:8080/**` too if you test locally. |

Confirmation emails and magic links send you back to the exact page address, so the address must be listed under Redirect URLs. Open the magic link **in the same browser** where you requested it, because sign-in uses the secure PKCE flow.

> The built-in email sender on the free plan is rate-limited to a few emails per hour. That's fine for a personal app. For more, set up custom SMTP under Authentication → Emails.

## 4. Find the project URL and the anon / publishable key

Go to **Project Settings → Data API** (older dashboards: *Settings → API*) and copy:

- **Project URL**, e.g. `https://abcd1234.supabase.co`
- the **anon public** key (`eyJ…`) or, in newer dashboards, the **publishable** key (`sb_publishable_…`), found under **Project Settings → API Keys**

Never use the `service_role` / `sb_secret_…` key. It bypasses Row Level Security, and the app refuses it.

In the app, go to **Settings → Cloud sync**. Paste the URL and key, then click **Connect** and **Create account** (or **Sign in**). The URL and key are stored only in this browser's localStorage. They're never put into synced records and never hardcoded in the file.

## 5. Host the folder on https (needed for install and offline)

Supabase Auth, installing the app and offline mode all need a real https address, and every device should open the same one.

**GitHub Pages**
1. Create a repository (e.g. `my-life-os`) and upload everything in the folder: `index.html`, `sw.js`, `manifest.webmanifest` and the `icons/` folder.
2. Go to **Settings → Pages → Build and deployment**, set the source to *Deploy from a branch*, choose `main` / root, and save.
3. After a minute, the app is live at `https://<username>.github.io/my-life-os/`.

**Netlify** — go to <https://app.netlify.com/drop> and drag the whole folder onto the page. You get an `https://….netlify.app` URL straight away.

**Vercel** — run `npx vercel` inside the folder, or import the GitHub repo at <https://vercel.com/new>. No build settings are needed.

After you deploy, put the final URL into **Site URL** and **Redirect URLs** (step 3).

**Note on data per address:** IndexedDB data belongs to one address (origin). If you were using the app as a local file before, open the old copy, **export a JSON backup**, then restore it on the hosted copy. Alternatively, connect sync on the old copy first and choose *Upload this device's data*.

## 6. Install it as an app (PWA)

- **Android / Chrome / Edge (desktop too):** open the hosted URL, then go to **Settings → Install app → Install My Life OS**. Or use the browser menu → *Install app* / *Add to Home screen*.
- **iPhone / iPad:** open it in **Safari** → **Share** → **Add to Home Screen**.
- It opens in its own window with the app icon, and has shortcuts (long-press the icon) to Tasks, Finance, Journal and Notes.
- **Offline:** after the first visit, the app page, icons and libraries are cached, so it opens with no connection. Your data is always in IndexedDB on the device, so it's never lost by clearing this cache. Sync catches up when you're back online.
- **Updates:** upload a new `index.html` and the app picks it up on the next open. If a newer version arrives while the app is open, you'll see *"A new version is ready" → Reload*. It never reloads on its own, so you don't lose what you're typing.

### Replacing the placeholder logo

Swap the files in `icons/` and keep the same names and sizes:

| File | Size | Notes |
|---|---|---|
| `icon.svg` | any | Main logo, also used as the browser-tab icon |
| `icon-192.png`, `icon-512.png` | 192², 512² | Rounded corners / transparency OK |
| `maskable-192.png`, `maskable-512.png` | 192², 512² | **Full-bleed background**, logo inside the middle ~80% (Android crops these into circles and other shapes) |
| `apple-touch-icon.png` | 180² | iPhone home screen; no transparency |
| `favicon-32.png` | 32² | Fallback tab icon |

Then change `const VERSION = 'v1'` to `'v2'` at the top of `sw.js`, so installed copies download the new icons. Note that installed apps on Android sometimes keep the old home-screen icon until you reinstall. The small "OS" badge in the sidebar is separate: it's the `.brand-mark` element in `index.html`.

## 7. Free-plan notes

- **Projects pause after 1 week of inactivity.** You'll get a warning email first. Open the project in the dashboard and click **Resume**. Data is kept, and you can restore a paused project for up to a year. While the project is paused, the app shows *"can't reach Supabase"* and keeps working locally. Changes wait in the outbox and upload after you resume.
- **Automatic backups are not included on the Free plan** (daily backups and point-in-time recovery are paid features). Keep using **Settings → Export full backup (JSON)** regularly. That file is your real backup.
- The free limits (500 MB database, 50,000 monthly active users) are far more than one person's life data needs.

## How sync behaves (quick reference)

- **When it syncs:** on sign-in and on app start, then every 60 s while the tab is visible, when the connection comes back, and about 2 s after each change. You can also press *Sync now*. Auto-sync can be turned off. Nothing syncs while offline.
- **Conflicts:** last write wins per record, using each record's `updatedAt`. For example, if you edit the same task on two devices, the later edit wins. A record syncs as a whole, so two devices changing *different parts* of the same record (such as checking off a habit on different days while both are offline) keep only the later version of that record.
- **Clocks:** last-write-wins compares the devices' clocks, so keep automatic time enabled on your devices.
- **Deletes** sync as tombstones. To tidy up old tombstones, there's an optional cleanup query at the bottom of `supabase.sql`.
- **First sign-in on a device that already has data,** when the cloud has data too: you choose **Merge (newest wins)**, **Upload this device's data** (the cloud becomes this device; cloud-only items are deleted) or **Replace with cloud data** (asks again before discarding local data). If only one side has data, it's copied across without asking. *Cancel* pauses sync until you choose.
- **Not synced (device-only):** sidebar collapsed state, which reminders were already shown, the "last backup" date, and all sync settings.
- **Demo data** isn't uploaded unless you turn on *Upload demo data*.
- **Erase all data** offers *This device only* (you're signed out, the cloud copy is kept, and signing in again brings it back) or *This device and the cloud* (deleted everywhere; your other devices clear on their next sync).
- **Realtime is not used.** Changes from other devices arrive by polling, within about a minute, or straight away with *Sync now*.

## Troubleshooting

| Message | Fix |
|---|---|
| *the cloud table isn't set up* | Run `supabase.sql` (step 2). |
| *permission denied by Row Level Security* | Re-run `supabase.sql`, then sign out and sign in again. |
| *your session expired or the key is wrong* | Check the key in Settings → Cloud sync, then sign in again. |
| *can't reach Supabase* | Check your connection, or resume a paused project. It retries automatically. |
| *could not load the Supabase library* | jsDelivr is blocked or unreachable on this network. The app keeps working locally. |
| Confirmation link opens the wrong site | Fix Site URL / Redirect URLs (step 3). |
