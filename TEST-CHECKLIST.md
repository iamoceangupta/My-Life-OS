# Sync test checklist — results

**Run on:** 27 Nov 2026, against the final `my-life-os-standalone.html`.

**Environment:** a local copy of the Supabase stack, not a hosted project:

- Postgres 16
- PostgREST v12.2.3 (the REST API Supabase uses)
- Supabase Auth (GoTrue) v2.177.0
- a small gateway that puts them on one URL, the way Supabase's API gateway does

`supabase.sql` was applied unchanged, twice, to check it's safe to re-run. The browser was Chromium via Playwright. Each "device" is a separate browser profile with its own IndexedDB and localStorage. supabase-js 2.119.0 was served from the npm package at the pinned jsDelivr URL, with the SRI hash checked.

**Result: 57/57 sync checks, 17/17 PWA checks and 9/9 API-level security checks passed.** The sync suite was re-run with the service worker active.

**Not tested here:**

- a hosted supabase.co project
- email delivery (confirmation emails and magic links). The local Auth server auto-confirmed sign-ups.
- Realtime (not implemented; sync uses polling)

Do the "Your own run" section below once your project is live.

## Required scenarios

| # | Scenario | Result |
|---|---|---|
| 1 | Two browsers on one account: create in A, it appears in B | ✅ |
| 1 | Edit in B, it appears in A | ✅ |
| 1 | Delete in A writes a tombstone (`deleted = true`) and B removes the record | ✅ |
| 1 | B receives A's change via the 60 s poll, without pressing Sync now | ✅ |
| 2 | Offline: indicator shows *Offline*, edits are saved locally and wait in the outbox | ✅ |
| 2 | Reconnect: the `online` event syncs automatically, and the other device receives the edits | ✅ |
| 3 | Same record edited on both devices, older edit pushed **last**: server rejects it, and both devices and the cloud end on the newer edit | ✅ |
| 3 | Same record, older edit pushed **first**: newer edit overwrites it everywhere | ✅ |
| 4 | First sign-in with data on both sides shows the app modal with Merge / Upload / Replace | ✅ |
| 4 | **Merge:** union of both, newest copy of a shared record wins, no duplicate default lists | ✅ |
| 4 | **Upload:** the cloud and the other device now match this device; cloud-only record deleted | ✅ |
| 4 | **Replace:** asks again, then this device matches the cloud | ✅ |
| 4 | **Cancel:** sync paused ("Sync paused"), nothing uploaded | ✅ |
| 5 | Deletes propagate, including the bulk *Remove demo data* | ✅ |
| 6 | No Supabase configured: v1 → v2 migration keeps existing data, indicator hidden, status "Not configured", saves persist, all routes render with no errors, supabase-js not downloaded | ✅ |

## Also checked

- Sign up / sign in / sign out; email shown; wrong password gives a clear message; a service_role key is refused
- Debounced push about 2 s after an edit; outboxes empty after sync; pulled rows are not re-queued (no echo)
- Settings sync (currency); `sidebarCollapsed` / `notified` stay on the device and are not in the cloud row
- Demo data not uploaded by default (including demo list items); the toggle uploads it; local demo items survive a pull
- A restored backup with old timestamps still syncs
- Backend unreachable: *Error: can't reach Supabase…* plus a toast; local data and outbox kept; automatic backoff retry succeeds when the backend is back
- Erase *this device only*: signed out, cloud kept, and signing back in restores the data. Erase *device + cloud*: other device cleared, fresh defaults
- A `<img onerror>` payload synced in a task title is shown as text, not run
- Signing out keeps local data
- Layout: dark mode; iPhone-width Settings has no horizontal scroll

**API / RLS (rls-test.js, two real users):**

- anon key gets *permission denied*
- user B can't read, insert-as-A, update or delete A's rows
- `user_id` defaults to `auth.uid()`
- stale `updated_at` writes are skipped
- the trigger bumps `server_updated_at`, which can't be backdated

## PWA (pwa-test.js)

| Check | Result |
|---|---|
| Manifest found and parses with no errors (Chrome DevTools) | ✅ |
| Chrome reports the app as **installable** (no installability errors) | ✅ |
| Service worker registers, activates and controls the page | ✅ |
| App page, icons and pinned libraries (Chart.js, SheetJS, fonts) precached on first visit | ✅ |
| **Fully offline** (network off, no test stubs): app reopens with its data, Chart.js comes from cache, routes render | ✅ |
| Offline: supabase-js loads from cache (once sync has loaded it) and passes its SRI check | ✅ |
| Offline: a URL with `?code=…` (Supabase redirect) still opens the cached app | ✅ |
| New `sw.js` version: "A new version is ready" toast with Reload (no forced reload); old cache removed | ✅ |
| Opened as a plain file: runs normally, explains how to install | ✅ |
| Dashboard has no Customize button; Settings → Customize dashboard still opens the editor | ✅ |
| Sync status chip in the top bar is actually hidden when sync isn't configured | ✅ |

**Not tested:** installing on a real phone (iOS Add to Home Screen, Android icon shapes). Do this in the "Your own run" section below.

## Your own run (after deploying)

- [ ] Install from Settings → Install app on Android/desktop, or Share → Add to Home Screen on iPhone; it opens in its own window
- [ ] Turn on airplane mode and open the installed app: it loads with your data

- [ ] Open the hosted URL on a phone and a laptop, connect both, and sign in on both
- [ ] Add a transaction on the laptop; it appears on the phone within about a minute (or tap Sync now)
- [ ] Turn on airplane mode on the phone, edit something, turn it off, and check it reaches the laptop
- [ ] Create an account with **Confirm email** on: the confirmation link returns to your hosted page and signs you in
- [ ] Try *Email me a magic link* (open it in the same browser)
- [ ] Export a JSON backup and keep it somewhere safe
