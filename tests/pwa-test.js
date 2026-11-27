// PWA checks: manifest validity, installability, service worker, offline start, update flow.
const { chromium } = require('playwright');
const fs = require('fs');
const NM = '/home/claude/infra/node_modules/';
const APP = 'http://localhost:8000/';
const results = [];
const check = (c, n, x = '') => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ serviceWorkers: 'allow' });
  let cdnHits = 0;
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/chart\.js/, r => { cdnHits++; r.fulfill({ body: fs.readFileSync(NM + 'chart.js/dist/chart.umd.js'), headers: { 'content-type': 'application/javascript' } }); });
  await ctx.route(/cdnjs\.cloudflare\.com/, r => { cdnHits++; r.fulfill({ body: fs.readFileSync(NM + 'xlsx/dist/xlsx.full.min.js'), headers: { 'content-type': 'application/javascript' } }); });
  await ctx.route(/supabase-js@2\.119\.0/, r => r.fulfill({ body: fs.readFileSync(NM + '@supabase/supabase-js/dist/umd/supabase.js'), headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' } }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ body: '/* font stub */', headers: { 'content-type': 'text/css' } }));
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(APP); await p.waitForSelector('#content .hero');

  // Manifest + installability (Chrome DevTools Protocol, same checks as the install button)
  const cdp = await ctx.newCDPSession(p);
  const man = await cdp.send('Page.getAppManifest');
  check(man.url.endsWith('/manifest.webmanifest') && man.errors.length === 0, 'Manifest found and parses with no errors', man.errors.map(e => e.message).join('; '));
  await p.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => { });
  const inst = await cdp.send('Page.getInstallabilityErrors');
  check(inst.installabilityErrors.length === 0, 'Chrome reports the app as installable', JSON.stringify(inst.installabilityErrors));

  const sw = await p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { active: !!(r && r.active), scope: r && r.scope, ctrl: !!navigator.serviceWorker.controller }; });
  check(sw.active && sw.scope === APP && sw.ctrl, 'Service worker registered, active and controlling the page', JSON.stringify(sw));
  const caches = await p.evaluate(async () => { const out = {}; for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map(r => r.url.replace(location.origin, '')); return out; });
  check(caches['lifeos-shell-v1'] && caches['lifeos-shell-v1'].includes('/') && caches['lifeos-shell-v1'].includes('/icons/icon-512.png'), 'App page and icons precached', JSON.stringify(Object.keys(caches)));

  // Dashboard: no Customize button; Settings still has it
  check(!(await p.$('.hero [data-customize]')) && !(await p.$('#content button:has-text("Customize")')), 'Dashboard has no "Customize" button');
  await p.goto(APP + '#prefs'); await p.waitForSelector('#pwa-body');
  check(await p.isVisible('[data-cust]'), 'Settings still has "Customize dashboard"');
  await p.click('[data-cust]'); await sleep(300);
  check(await p.isVisible('.modal'), 'Settings → Customize dashboard opens the widget editor');
  await p.keyboard.press('Escape');
  const pwaTxt = await p.textContent('#pwa-body');
  check(/Ready to work offline/.test(pwaTxt), 'Settings → Install app shows "Ready to work offline"', pwaTxt.trim().slice(0, 120));
  await p.screenshot({ path: '/tmp/pwa-settings.png' });

  // Load the libraries once online so they get cached, then go fully offline and reopen
  await p.goto(APP + '#analytics'); await sleep(800);
  await p.evaluate(() => save('tasks', { title: 'Made before going offline', status: 'todo', tags: [], subtasks: [] }));
  await p.evaluate(() => Sync.loadLib());   // as when cloud sync is set up: loaded once online, through the worker
  await sleep(300);
  const libsCached = await p.evaluate(async () => (await (await caches.open('lifeos-libs-v1')).keys()).map(r => r.url));
  console.log('      libs cache:', libsCached.map(u => u.split('/').slice(2, 3)[0] + '/…' + u.slice(-24)).join(', '));
  await ctx.unrouteAll({ behavior: 'ignoreErrors' });   // no more stubs: only the service worker can supply the libraries now
  await ctx.setOffline(true);
  await p.reload(); await p.waitForSelector('#content .page-head, #content .hero', { timeout: 10000 });
  const off = await p.evaluate(() => ({ chart: typeof Chart, tasks: S.data.tasks.some(t => t.title === 'Made before going offline'), title: document.title }));
  check(/My Life OS/.test(off.title) && off.tasks, 'Fully offline: app reopens from cache with its data', JSON.stringify(off));
  check(off.chart === 'function', 'Fully offline: Chart.js served from the service worker cache');
  const lib = await p.evaluate(() => Sync.loadLib());
  check(lib === true, 'Fully offline: supabase-js loads from cache and passes its SRI check');
  await p.goto(APP + '#finance'); await sleep(300); await p.goto(APP + '#tasks'); await sleep(300);
  const txt = await p.evaluate(() => document.querySelector('#content').innerText);
  check(/1 open/.test(txt) && /All\s*\/\s*1/.test(txt.replace(/\n/g,' / ')), 'Fully offline: routes render and data is there', txt.slice(0, 160).replace(/\n/g, ' / '));
  // A deep link with a query string (e.g. the Supabase ?code= redirect) still opens offline
  await p.goto(APP + '?code=abc#home'); await p.waitForSelector('#content .hero', { timeout: 10000 });
  check(true, 'Offline: URL with a query string falls back to the cached app');
  await ctx.setOffline(false);

  // Update flow: a changed sw.js activates and the page offers a reload instead of forcing one
  const swPath = '/home/claude/pwa/sw.js', orig = fs.readFileSync(swPath, 'utf8');
  fs.writeFileSync(swPath, orig.replace("const VERSION = 'v1';", "const VERSION = 'v2';"));
  try {
    await p.goto(APP); await p.waitForSelector('#content .hero');
    await p.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
    await p.waitForSelector('.toast:has-text("A new version")', { timeout: 10000 });
    check(await p.isVisible('.toast .act:has-text("Reload")'), 'New version → "A new version is ready" toast with a Reload button (no forced reload)');
    await sleep(2500);
    const keys = await p.evaluate(() => caches.keys());
    check(keys.includes('lifeos-shell-v2') && !keys.includes('lifeos-shell-v1'), 'Old app cache removed when the new version activates', keys.join(','));
  } finally { fs.writeFileSync(swPath, orig); }

  check(errs.length === 0, 'No page errors', errs.join(' | '));
  await browser.close();

  // Without the PWA files (single HTML via file://) the app still runs normally
  const b2 = await chromium.launch(); const p2 = await b2.newPage(); const e2 = []; p2.on('pageerror', e => e2.push(String(e)));
  await p2.route(/^https:/, r => r.fulfill({ body: '' }));
  await p2.goto('file:///home/claude/work/my-life-os-standalone.html'); await p2.waitForSelector('#content .hero');
  await p2.goto('file:///home/claude/work/my-life-os-standalone.html#prefs'); await p2.waitForSelector('#pwa-body');
  check(e2.length === 0 && /needs the app to be hosted on https/.test(await p2.textContent('#pwa-body')), 'Opened as a plain file: runs normally, no SW, explains how to install', e2.join('|'));
  await b2.close();
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
