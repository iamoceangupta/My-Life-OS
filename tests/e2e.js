// End-to-end sync tests: two (or more) isolated Chromium profiles against a local
// Supabase stack (Postgres 16 + PostgREST 12 + Supabase Auth v2.177) behind gateway.js.
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const [ANON, SERVICE] = fs.readFileSync(__dirname + '/keys.txt', 'utf8').trim().split('\n');
const APP = 'http://localhost:8000/';
const NM = '/home/claude/infra/node_modules/';
const RUN = Date.now().toString(36);
const admin = createClient('http://localhost:8000', SERVICE, { auth: { persistSession: false } });
const results = [];
const check = (cond, name, extra = '') => { results.push([!!cond, name]); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let browser;
const cdnRequests = [];
async function device(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\.119\.0\/dist\/umd\/supabase\.js/, r => { cdnRequests.push(name); r.fulfill({ body: fs.readFileSync(NM + '@supabase/supabase-js/dist/umd/supabase.js'), headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' } }); });
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/chart\.js/, r => r.fulfill({ body: fs.readFileSync(NM + 'chart.js/dist/chart.umd.js'), headers: { 'content-type': 'application/javascript' } }));
  await ctx.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx/, r => r.fulfill({ body: fs.readFileSync(NM + 'xlsx/dist/xlsx.full.min.js'), headers: { 'content-type': 'application/javascript' } }));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/\[sync\]|Failed to load resource|ERR_INTERNET_DISCONNECTED|net::/.test(m.text())) page.errors.push(m.text()); });
  page.ctx = ctx; page.name = name;
  await page.goto(APP);
  await page.waitForFunction(() => window.Sync !== undefined || typeof Sync !== 'undefined');
  await page.waitForSelector('#content');
  await sleep(1800); // let first-run timers (reminder check etc.) settle
  return page;
}
const ev = (p, fn, arg) => p.evaluate(fn, arg);
async function configure(p) {
  await p.goto(APP + '#prefs'); await p.waitForSelector('#sy-url');
  await p.fill('#sy-url', 'http://localhost:8000'); await p.fill('#sy-key', ANON);
  if ((await p.inputValue('#sy-url')) !== 'http://localhost:8000') { await p.fill('#sy-url', 'http://localhost:8000'); await p.fill('#sy-key', ANON); }
  await p.click('[data-sync-cfg] button[type=submit]');
  try { await p.waitForSelector('#sy-email', { timeout: 15000 }); }
  catch (e) { console.log('configure debug', p.name, JSON.stringify(await p.evaluate(() => ({ st: Sync.state, err: Sync.error, user: Sync.user && Sync.user.email, body: (document.querySelector('#sync-body') || {}).innerText, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent) })))); await p.screenshot({ path: '/tmp/cfg-fail.png' }); throw e; }
}
async function signUp(p, email) { await p.fill('#sy-email', email); await p.fill('#sy-pass', 'secret123'); await p.click('[data-sync-signup]'); }
async function signIn(p, email) { await p.fill('#sy-email', email); await p.fill('#sy-pass', 'secret123'); await p.click('[data-sync-auth] button[type=submit]'); }
const idleSynced = p => p.waitForFunction(() => Sync.state === 'synced' && !Sync.busy && Sync.lastAt, null, { timeout: 20000 });
const syncNow = async p => { await ev(p, () => Sync.run('test')); await ev(p, () => Sync.whenIdle()); };
const tasks = p => ev(p, () => S.data.tasks.map(t => ({ id: t.id, title: t.title, updatedAt: t.updatedAt })));
const addTask = (p, title) => ev(p, t => save('tasks', { title: t, status: 'todo', priority: 'Medium', category: 'Personal', due: '', tags: [], subtasks: [] }).then(o => o.id), title);
const editTask = (p, id, title) => ev(p, ([id, t]) => { const o = { ...byId('tasks', id), title: t }; return save('tasks', o).then(() => true); }, [id, title]);
const outboxCount = p => ev(p, () => DB.tx('outbox', 'readonly', os => os.count()));
async function cloudRows(email, store) {
  const { data: u } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const user = u.users.find(x => x.email === email);
  let q = admin.from('records').select('*').eq('user_id', user.id); if (store) q = q.eq('store', store);
  return (await q).data;
}

(async () => {
  browser = await chromium.launch();

  /* ---------- 0. No Supabase configured: app behaves as before ---------- */
  {
    const ctx = await browser.newContext();
    const pre = await ctx.newPage();
    // Create a v1 DB on the app origin before the new app ever runs (serve an empty page at the same origin).
    await pre.route(APP + '?seed', r => r.fulfill({ body: '<html><body>seed</body></html>', headers: { 'content-type': 'text/html' } }));
    await pre.goto(APP + '?seed');
    await pre.evaluate(() => new Promise((res, rej) => {
      const r = indexedDB.open('my-life-os', 1);
      r.onupgradeneeded = () => { ['tx', 'budgets', 'debts', 'savings', 'tasks', 'habits', 'goals', 'notes', 'journal', 'events', 'lists', 'meta'].forEach(s => r.result.createObjectStore(s, { keyPath: 'id' })); };
      r.onsuccess = () => { const db = r.result; const t = db.transaction(['tasks', 'meta'], 'readwrite'); t.objectStore('tasks').put({ id: 'legacy1', title: 'Legacy v1 task', status: 'todo', createdAt: 1, updatedAt: 1 }); t.objectStore('meta').put({ id: 'settings', name: 'Sagar', onboarded: true, currency: 'INR' }); t.oncomplete = () => { db.close(); res(); }; };
      r.onerror = () => rej(r.error);
    }));
    await pre.close();
    await ctx.route(/cdn\.jsdelivr\.net\/npm\/@supabase/, r => { cdnRequests.push('noconfig'); r.abort(); });
    await ctx.route(/cdn\.jsdelivr\.net\/npm\/chart\.js/, r => r.fulfill({ body: fs.readFileSync(NM + 'chart.js/dist/chart.umd.js'), headers: { 'content-type': 'application/javascript' } }));
    await ctx.route(/cdnjs\.cloudflare\.com/, r => r.fulfill({ body: fs.readFileSync(NM + 'xlsx/dist/xlsx.full.min.js'), headers: { 'content-type': 'application/javascript' } }));
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
    await p.goto(APP); await p.waitForSelector('#content .card, #content .page-head, #content .hero');
    const st = await ev(p, async () => ({ ver: DB.db.version, stores: [...DB.db.objectStoreNames], legacy: !!byId('tasks', 'legacy1'), name: S.settings.name, ind: getComputedStyle(document.querySelector('#sync-ind')).display === 'none', state: Sync.state }));
    check(st.ver === 2 && st.stores.includes('outbox'), 'IndexedDB migrates v1 → v2 and adds "outbox"');
    check(st.legacy && st.name === 'Sagar', 'Existing v1 data and settings survive the migration');
    check(st.ind && st.state === 'nocfg', 'No config: sync indicator hidden, state "Not configured"');
    await addTask(p, 'Offline-only task');
    await p.reload(); await p.waitForSelector('#content');
    check((await tasks(p)).some(t => t.title === 'Offline-only task'), 'No config: saves persist across reload');
    await p.goto(APP + '#prefs'); await p.waitForSelector('#sync-status');
    check((await p.textContent('#sync-status')).includes('Not configured'), 'Settings shows "Not configured"');
    for (const r of ['tasks', 'finance', 'habits', 'goals', 'calendar', 'notes', 'journal', 'records', 'analytics', 'home']) { await p.goto(APP + '#' + r); await sleep(120); }
    check(!cdnRequests.includes('noconfig'), 'No config: supabase-js is not even downloaded');
    check(errs.length === 0, 'No config: no page errors on any route', errs.join(' | '));
    await ctx.close();
  }

  /* ---------- 1. Two browsers, same account: create / edit / delete ---------- */
  const EMAIL = `sagar+${RUN}@test.dev`;
  const A = await device('A'), B = await device('B');
  await configure(A);
  check(await ev(A, () => document.querySelector('#sync-status').textContent.includes('Signed out')), 'Configured, not signed in: status "Signed out"');
  check(cdnRequests.includes('A'), 'supabase-js loads from the pinned jsDelivr URL with SRI');
  await signUp(A, EMAIL); await idleSynced(A);
  check(await A.isVisible('#sync-email') && (await A.textContent('#sync-email')) === EMAIL, 'Sign up → signed in, email shown');
  check((await A.textContent('#sync-ind .lbl')) === 'Synced', 'Top-bar indicator shows "Synced"');
  const listsA = await ev(A, () => S.data.lists.length);
  await configure(B); await signIn(B, EMAIL); await idleSynced(B);
  const listsB = await ev(B, () => S.data.lists.length);
  check(listsA === 7 && listsB === 7, 'Fresh second device adopts cloud data without duplicate default lists', `A=${listsA} B=${listsB}`);

  if (!process.env.FAST) {
  const t1 = await addTask(A, 'Buy milk');
  await A.waitForFunction(() => Sync.lastAt && !Sync.busy && Sync.pendingCount === 0, null, { timeout: 10000 }).catch(() => { });
  await sleep(3500); // debounced auto-sync (~2 s) after the edit
  const rows1 = await cloudRows(EMAIL, 'tasks');
  check(rows1.some(r => r.id === t1 && r.data.title === 'Buy milk' && !r.deleted), 'Local edit auto-pushes ~2 s later (debounced)');
  await syncNow(B);
  check((await tasks(B)).some(t => t.id === t1 && t.title === 'Buy milk'), 'Create in A → appears in B');
  check(await outboxCount(B) === 0, 'Applying remote rows does not re-queue them (no echo)');
  await editTask(B, t1, 'Buy oat milk'); await syncNow(B); await syncNow(A);
  check((await tasks(A)).find(t => t.id === t1).title === 'Buy oat milk', 'Edit in B → appears in A');
  await ev(A, id => removeItem('tasks', id), t1); await syncNow(A);
  const tomb = (await cloudRows(EMAIL, 'tasks')).find(r => r.id === t1);
  check(tomb && tomb.deleted === true, 'Delete writes a tombstone (deleted = true) in Supabase');
  await syncNow(B);
  check(!(await tasks(B)).some(t => t.id === t1), 'Delete in A → removed in B');
  check(await outboxCount(A) === 0 && await outboxCount(B) === 0, 'Outboxes empty after sync (no local tombstones kept)');

  // Polling picks up remote changes without any manual sync
  const t2 = await addTask(B, 'From B, wait for poll');
  await syncNow(B);
  await A.bringToFront();
  await A.waitForFunction(id => S.data.tasks.some(t => t.id === id), t2, { timeout: 75000 }).then(() => check(true, 'A receives B\'s change via 60 s polling (no manual sync)')).catch(() => check(false, 'A receives B\'s change via 60 s polling'));

  // Settings sync, device-only fields stay local
  await ev(A, async () => { S.settings.currency = 'USD'; S.settings.sidebarCollapsed = true; await saveSettings(); });
  await syncNow(A); await syncNow(B);
  const sb = await ev(B, () => ({ cur: S.settings.currency, col: S.settings.sidebarCollapsed }));
  check(sb.cur === 'USD', 'Settings sync (currency changed in A → B)');
  check(sb.col === false, 'Device-only field (sidebarCollapsed) does not sync');
  const metaRow = (await cloudRows(EMAIL, 'meta'))[0];
  check(metaRow && !('notified' in metaRow.data) && !('sidebarCollapsed' in metaRow.data), 'Cloud settings row excludes notified / sidebarCollapsed');

  /* ---------- 2. Offline edits, then reconnect ---------- */
  await A.ctx.setOffline(true);
  await A.waitForFunction(() => Sync.state === 'offline');
  check((await A.textContent('#sync-ind .lbl')) === 'Offline', 'Going offline shows "Offline"');
  const t3 = await addTask(A, 'Written offline');
  await editTask(A, t2, 'Edited offline');
  await sleep(2600);
  check(await outboxCount(A) === 2, 'Offline edits wait in the outbox', 'count=' + await outboxCount(A));
  check((await tasks(A)).some(t => t.id === t3), 'App keeps working offline (record saved locally)');
  await A.ctx.setOffline(false);
  await A.waitForFunction(() => Sync.state === 'synced' && !Sync.busy && Sync.pendingCount === 0, null, { timeout: 15000 }).catch(() => { });
  check(await outboxCount(A) === 0, 'Reconnect ("online" event) syncs automatically');
  await syncNow(B);
  const tb = await tasks(B);
  check(tb.some(t => t.id === t3) && tb.find(t => t.id === t2).title === 'Edited offline', 'Offline edits reach the other device');

  /* ---------- 3. Same record edited on both sides → newest wins ---------- */
  for (const order of ['older-pushes-last', 'older-pushes-first']) {
    await A.ctx.setOffline(true); await B.ctx.setOffline(true);
    if (order === 'older-pushes-last') { await editTask(A, t3, 'A edit (older)'); await sleep(30); await editTask(B, t3, 'B edit (newer)'); }
    else { await editTask(B, t3, 'B edit (older)'); await sleep(30); await editTask(A, t3, 'A edit (newer)'); }
    await B.ctx.setOffline(false); await sleep(200); await syncNow(B);
    await A.ctx.setOffline(false); await sleep(200); await syncNow(A); await syncNow(B);
    const want = order === 'older-pushes-last' ? 'B edit (newer)' : 'A edit (newer)';
    const a = (await tasks(A)).find(t => t.id === t3).title, b = (await tasks(B)).find(t => t.id === t3).title, c = (await cloudRows(EMAIL, 'tasks')).find(r => r.id === t3).data.title;
    check(a === want && b === want && c === want, `Conflict (${order}): both devices and cloud end on the newest edit`, `A="${a}" B="${b}" cloud="${c}"`);
  }

  /* ---------- 4. Escaping synced values ---------- */
  await addTask(B, '<img src=x onerror="window.__pwned=1">'); await syncNow(B); await syncNow(A);
  await A.goto(APP + '#tasks'); await sleep(400); await A.fill('#gsearch', 'img'); await sleep(300);
  check(!(await ev(A, () => window.__pwned)), 'Synced HTML in a title is escaped, not executed');

  /* ---------- 5. Demo data: not uploaded unless the toggle is on ---------- */
  await ev(A, () => loadDemo()); await sleep(2800); await syncNow(A);
  let demoRows = (await cloudRows(EMAIL)).filter(r => r.data && r.data.demo && !r.deleted);
  const listItemsDemo = (await cloudRows(EMAIL, 'lists')).some(r => (r.data.items || []).some(i => i.demo));
  check(demoRows.length === 0 && !listItemsDemo, 'Demo records and demo list items are not uploaded by default');
  await syncNow(B);
  const bListsDemo = await ev(B, () => S.data.lists.some(l => (l.items || []).some(i => i.demo)));
  check(!bListsDemo && await ev(A, () => S.data.lists.some(l => (l.items || []).some(i => i.demo))), 'A keeps its demo list items locally after pulling lists');
  await A.goto(APP + '#prefs'); await A.waitForSelector('[data-sync-demo]'); await A.click('[data-sync-demo]'); await sleep(300); await syncNow(A);
  demoRows = (await cloudRows(EMAIL)).filter(r => r.data && r.data.demo && !r.deleted);
  check(demoRows.length > 20, 'Toggle on → demo data uploads', 'rows=' + demoRows.length);
  await syncNow(B);
  check(await ev(B, () => S.data.tx.some(t => t.demo)), 'Demo data reaches B once uploaded');
  await ev(A, () => { const orig = window.confirmBox; window.confirmBox = async () => true; return removeDemo().finally(() => { window.confirmBox = orig; }); }).catch(() => { });
  // removeDemo uses the modal confirm: click it if open
  if (await A.isVisible('.modal [data-ok]')) await A.click('.modal [data-ok]');
  await sleep(500); await syncNow(A); await syncNow(B);
  check(!(await ev(B, () => STORES.some(s => S.data[s].some(x => x.demo)))), 'Remove demo data (bulk delete) propagates to B');
  await ev(A, () => Sync.setCfg({ demo: false }));

  /* ---------- 6. Backup restore stays correct with sync ---------- */
  const backup = await ev(A, () => JSON.stringify({ app: 'my-life-os', version: 1, data: { tasks: [{ id: 'restored1', title: 'From backup', status: 'todo', createdAt: 5, updatedAt: 5 }] } }));
  await A.goto(APP + '#prefs'); await A.waitForSelector('[data-restore]'); await A.click('[data-restore]');
  await A.fill('#rs-text', backup); await A.click('.modal [data-go]'); await sleep(400); await syncNow(A); await syncNow(B);
  check((await tasks(B)).some(t => t.id === 'restored1'), 'Restored (old-timestamp) backup records still sync to other devices');

  /* ---------- 7. Network errors: clear message, retry with backoff, no data loss ---------- */
  const before = (await tasks(A)).length;
  await fetch('http://localhost:8000/__down');
  const t4 = await addTask(A, 'Saved while server down');
  await syncNow(A);
  const es = await ev(A, () => ({ st: Sync.state, err: Sync.error, toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '), retry: !!Sync.retryTimer }));
  check(es.st === 'error' && /can't reach Supabase/.test(es.err), 'Unreachable backend → status "Error: can\'t reach Supabase…"', es.err);
  check(/Sync failed/.test(es.toast) && /safe on this device/.test(es.toast), 'Error toast shown');
  check((await tasks(A)).length === before + 1 && await outboxCount(A) >= 1, 'Failed sync keeps local data and the outbox entry');
  await fetch('http://localhost:8000/__up');
  await A.waitForFunction(() => Sync.state === 'synced' && Sync.pendingCount === 0, null, { timeout: 15000 }).then(() => check(true, 'Automatic retry (backoff) succeeds once the backend is back')).catch(() => check(false, 'Automatic retry succeeds'));
  check((await cloudRows(EMAIL, 'tasks')).some(r => r.id === t4), 'Change made during the outage reached the cloud');

  }
  /* ---------- 8. Auth error handling ---------- */
  {
    const P = await device('P'); await configure(P);
    await signIn(P, EMAIL.replace('@', '-nope@'));
    await P.waitForSelector('#sy-err:not([hidden])');
    check((await P.textContent('#sy-err')) === 'Wrong email or password.', 'Bad credentials → clear message');
    await P.fill('#sy-key', SERVICE); await P.click('[data-sync-cfg] button[type=submit]'); await sleep(300);
    check((await ev(P, () => [...document.querySelectorAll('.toast')].map(t => t.textContent).join('|'))).includes('secret (service_role) key'), 'service_role key is refused in the UI');
    await P.ctx.close();
  }

  /* ---------- 9. First sign-in choices on a device that already has data ---------- */
  for (const choice of ['merge', 'upload', 'replace', 'cancel']) {
    const email = `choice-${choice}+${RUN}@test.dev`;
    const seed = await device('seed-' + choice); await configure(seed); await signUp(seed, email); await idleSynced(seed);
    const cloudOnly = await addTask(seed, 'Cloud-only task'); const shared = await addTask(seed, 'Shared (cloud version)'); await syncNow(seed);
    const C = await device('C-' + choice);
    const localOnly = await addTask(C, 'Local-only task');
    // the same record id on both sides, local copy newer
    await ev(C, ([id]) => save('tasks', { id, title: 'Shared (device version)', status: 'todo', tags: [], subtasks: [] }), [shared]);
    await configure(C); await signIn(C, email);
    await C.waitForSelector('.modal [data-choice]', { timeout: 15000 });
    const labels = await C.$$eval('.modal [data-choice] b', b => b.map(x => x.textContent));
    if (choice === 'merge') check(labels.join('|') === "Merge (newest wins)|Upload this device's data|Replace with cloud data", 'First sign-in asks: Merge / Upload / Replace (app modal)', labels.join(' / '));
    if (choice === 'cancel') { await C.click('.modal [data-close]'); await sleep(500); check(await ev(C, () => Sync.state) === 'choose' && (await C.textContent('#sync-ind .lbl')) === 'Sync paused', 'Cancel → sync paused, nothing uploaded'); const cr = await cloudRows(email, 'tasks'); check(!cr.some(r => r.id === localOnly), 'Cancel: local data not uploaded'); await C.ctx.close(); await seed.ctx.close(); continue; }
    await C.click(`.modal [data-choice="${choice}"]`);
    if (choice === 'replace') { await C.waitForSelector('.modal [data-ok]'); await C.click('.modal [data-ok]'); }
    await idleSynced(C); await syncNow(seed);
    const ct = (await tasks(C)).map(t => t.title).sort(), st = (await tasks(seed)).map(t => t.title).sort();
    const cloud = (await cloudRows(email, 'tasks')).filter(r => !r.deleted).map(r => r.data.title).sort();
    const lists = await ev(C, () => S.data.lists.length);
    if (choice === 'merge') check(ct.join() === 'Cloud-only task,Local-only task,Shared (device version)' && cloud.join() === ct.join() && st.join() === ct.join() && lists === 7, 'Merge: union of both, newest copy of the shared record wins, no duplicate lists', `C=${ct} cloud=${cloud} lists=${lists}`);
    if (choice === 'upload') check(ct.join() === 'Local-only task,Shared (device version)' && cloud.join() === ct.join() && st.join() === ct.join(), 'Upload: cloud (and other device) now match this device; cloud-only record deleted', `cloud=${cloud} other=${st}`);
    if (choice === 'replace') check(ct.join() === 'Cloud-only task,Shared (cloud version)' && cloud.join() === ct.join(), 'Replace: this device now matches the cloud; local-only data discarded', `C=${ct}`);
    await C.ctx.close(); await seed.ctx.close();
  }

  /* ---------- 10. Erase all: this device only / device + cloud ---------- */
  await A.goto(APP + '#prefs'); await A.waitForSelector('[data-erase]'); await A.click('[data-erase]');
  check(await A.isVisible('#er-scope'), 'Erase dialog offers "This device only" / "This device and the cloud"');
  await A.fill('#er-c', 'DELETE'); await A.click('.modal [data-er]'); await sleep(800);
  const afterDev = await ev(A, () => ({ tasks: S.data.tasks.length, user: !!Sync.user }));
  const cloudStill = (await cloudRows(EMAIL, 'tasks')).filter(r => !r.deleted).length;
  check(afterDev.tasks === 0 && !afterDev.user && cloudStill > 0, 'Erase "this device only": local data gone, signed out, cloud kept', `cloud tasks=${cloudStill}`);
  await A.goto(APP + '#prefs'); await A.waitForSelector('#sy-email'); await signIn(A, EMAIL); await idleSynced(A);
  check((await tasks(A)).length === cloudStill, 'Signing back in after a device-only erase restores the data from the cloud');
  await A.goto(APP + '#prefs'); await A.waitForSelector('[data-erase]'); await A.click('[data-erase]');
  await A.click('#er-scope [data-v="cloud"]'); await A.fill('#er-c', 'DELETE'); await A.click('.modal [data-er]'); await sleep(1500);
  await syncNow(A); await syncNow(B);
  const live = (await cloudRows(EMAIL)).filter(r => !r.deleted);
  const bAfter = await ev(B, () => ({ tasks: S.data.tasks.length, tx: S.data.tx.length, lists: S.data.lists.length, cur: S.settings.currency }));
  check(live.every(r => r.store === 'lists' || r.store === 'meta') && bAfter.tasks === 0 && bAfter.tx === 0, 'Erase "device + cloud": cloud tombstoned, other device cleared on next sync', JSON.stringify(bAfter));
  check(bAfter.lists === 7 && bAfter.cur === 'INR', 'After cloud erase, other device gets the fresh defaults (7 lists, default settings)');

  /* ---------- 11. Sign out keeps local data; works offline & signed out ---------- */
  const keep = (await tasks(B)).length; await addTask(B, 'kept after sign out');
  await B.goto(APP + '#prefs'); await B.waitForSelector('[data-sync-out]'); await B.click('[data-sync-out]'); await sleep(500);
  check(await ev(B, () => Sync.state) === 'signedout' && (await tasks(B)).length === keep + 1, 'Sign out → "Signed out", local data kept');

  check(A.errors.length === 0 && B.errors.length === 0, 'No uncaught page errors on A or B', [...A.errors, ...B.errors].slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter(r => !r[0]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  fs.writeFileSync(__dirname + '/results.json', JSON.stringify(results));
  process.exit(failed.length ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); try { await browser.close(); } catch { } process.exit(2); });
