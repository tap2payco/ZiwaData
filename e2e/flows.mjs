// End-to-end flows against the built app + real server code (production mode, no .env, dry-run SMS).
// Run: npm run build && npm run e2e
import { BASE, NOW, launch, ready, startServer, wait } from './lib.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg, extra); } };
const api = async (path, opts) => { const r = await fetch(BASE + path, { ...opts, headers: { 'content-type': 'application/json' }, body: opts?.body ? JSON.stringify(opts.body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
const head = async (farm = 'farm-demo') => (await api(`/api/checkpoints?farmId=${farm}`)).body.latest;
const outboxCount = (page) => page.evaluate(() => new Promise((res, rej) => { const o = indexedDB.open('fish-early-warning-demo'); o.onsuccess = () => { const tx = o.result.transaction('outbox'); const c = tx.objectStore('outbox').count(); c.onsuccess = () => res(c.result); c.onerror = () => rej(c.error); }; o.onerror = () => rej(o.error); }));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(200); } return false; };
const url = (hash, extra = '') => `${BASE}/?now=${NOW}&dev=1${extra}#/farmer/${hash}`;
const newPage = async (browser, { sw = false } = {}) => {
  await api('/api/demo/reset', { method: 'POST' }); // each flow starts with a fresh server and a fresh phone
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: sw ? 'allow' : 'block' });
  await ctx.addInitScript(() => { try { if (!localStorage.getItem('app.lang')) localStorage.setItem('app.lang', 'en'); } catch {} });
  return { ctx, page: await ctx.newPage() };
};
const see = (page, text, timeout = 8000) => page.getByText(text).first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
async function recordDo(page, value) {
  await page.getByLabel('Dissolved oxygen', { exact: true }).fill(String(value));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}

const server = await startServer();
const browser = await launch();
try {
  // ---------------------------------------------------------------- A. simulated offline via the toggle
  console.log('A. Simulated offline: add a reading, see it in the outbox, send when back online');
  {
    const { ctx, page } = await newPage(browser);
    await page.goto(url('record'));
    await ready(page);
    ok(await until(async () => (await outboxCount(page)) === 0 && (await head())?.count > 1000), 'initial sync done, outbox empty');
    const before = (await head()).count;
    await page.getByRole('button', { name: 'Simulate offline' }).click();
    ok(await page.getByText('You are offline').isVisible(), 'offline banner shown');
    await recordDo(page, '5.9');
    ok(await page.getByText('Saved on this phone.').isVisible(), 'saved-on-phone message shown');
    ok(await page.getByText('Will send when there is signal.').isVisible(), 'will-send message shown');
    ok((await outboxCount(page)) === 1, 'reading is in the outbox (count = 1)');
    await wait(1500);
    ok((await head()).count === before, 'server has NOT received it while offline', `${(await head()).count} vs ${before}`);
    await page.getByRole('button', { name: 'Simulate offline' }).click(); // back online
    ok(await until(async () => (await outboxCount(page)) === 0), 'outbox empties after going back online');
    ok(await until(async () => (await head()).count === before + 1), 'server received exactly 1 new record', `${(await head()).count} vs ${before + 1}`);
    ok((await head()).chainOk === true, 'server checkpoint: chain OK');
    // idempotency: a second manual sync sends nothing new
    await page.goto(url('home'));
    await ready(page);
    await wait(1500);
    ok((await head()).count === before + 1, 'reload + re-sync does not duplicate the record');
    await ctx.close();
  }

  // ---------------------------------------------------------------- B. real offline (service worker + network cut)
  console.log('B. Real offline: service worker serves the app with the network cut');
  {
    const { ctx, page } = await newPage(browser, { sw: true });
    await page.goto(url('home'));
    await ready(page);
    const swReady = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; }).catch(() => false);
    ok(swReady, 'service worker active');
    await wait(1500); // let precache finish
    ok(await until(async () => (await outboxCount(page)) === 0), 'outbox empty before going offline');
    const before = (await head()).count;
    await ctx.setOffline(true);
    let reloaded = true;
    try { await page.goto(url('record')); await ready(page); } catch (e) { reloaded = false; console.log('   ', String(e).slice(0, 120)); }
    ok(reloaded, 'app reloads with no network (served from cache)');
    if (reloaded) {
      await recordDo(page, '6.2');
      ok(await page.getByText('Saved on this phone.').isVisible(), 'saved-on-phone shown with real network cut');
      ok((await outboxCount(page)) === 1, 'reading is in the outbox');
      await ctx.setOffline(false);
      ok(await until(async () => (await outboxCount(page)) === 0, 20000), 'outbox empties after network returns');
      ok(await until(async () => (await head()).count === before + 1), 'server received the record', `${(await head()).count} vs ${before + 1}`);
    }
    await ctx.close();
  }

  // ---------------------------------------------------------------- C. SMS dry-run through API
  console.log('C. SMS dry-run via the API');
  {
    await api('/api/settings', { method: 'PUT', body: { phone: null } });
    const st = await api('/api/sms/status');
    ok(st.body?.mode === 'dry-run' && st.body?.live === false, 'status says dry-run and not live', JSON.stringify(st.body));
    let r = await api('/api/sms/send', { method: 'POST', body: { kind: 'test', lang: 'sw', requestId: 'e2e-nophone' } });
    ok(r.status === 400 && r.body.error === 'no_phone', 'send without a saved number is refused (no_phone)');
    r = await api('/api/settings', { method: 'PUT', body: { phone: 'not a number' } });
    ok(r.status === 400, 'bad phone number rejected');
    r = await api('/api/settings', { method: 'PUT', body: { phone: '0712 345 678' } });
    ok(r.status === 200 && r.body.hasPhone && !JSON.stringify(r.body).includes('712345678'), 'phone saved; response only has the masked form', JSON.stringify(r.body));
    r = await api('/api/sms/send', { method: 'POST', body: { kind: 'alert', lang: 'sw', template: 'do_critical', params: { cage: 3, value: 3.8 }, requestId: 'e2e-alert-1', message: 'FREE TEXT SHOULD BE IGNORED' } });
    ok(r.status === 200 && r.body.state === 'dry_run' && r.body.dryRun === true, 'alert SMS returns state dry_run', JSON.stringify(r.body));
    ok(r.body.message === 'Tahadhari Kizimba 3: oksijeni 3.8 mg/L (chini). Acha kulisha. Angalia tena baada ya saa 1.', 'message is the exact spec template', r.body.message);
    ok(r.body.chars <= 160, `message is ${r.body.chars} chars (<= 160)`);
    const r2 = await api('/api/sms/send', { method: 'POST', body: { kind: 'alert', lang: 'sw', template: 'do_critical', params: { cage: 3, value: 3.8 }, requestId: 'e2e-alert-1' } });
    ok(r2.body.duplicate === true, 'same requestId is idempotent (duplicate)');
    r = await api('/api/sms/send', { method: 'POST', body: { kind: 'alert', lang: 'en', template: 'made_up', requestId: 'e2e-bad' } });
    ok(r.status === 400 && r.body.error === 'bad_template', 'unknown template refused (server sends templates only)');
    const log = await api('/api/sms/log');
    ok(log.body.log.some((e) => e.id === 'e2e-alert-1' && e.state === 'dry_run'), 'log records dry_run honestly');
    ok(!JSON.stringify(log.body).includes('712345678') && !JSON.stringify(log.body).includes('255712'), 'log contains no phone number');
    r = await api('/api/sms/balance', { method: 'POST' });
    ok(r.body?.ok === false || r.body?.dryRun === true || r.status >= 400, 'balance check does not pretend to be live', JSON.stringify(r.body));
    await api('/api/settings', { method: 'PUT', body: { phone: null } });
  }

  // ---------------------------------------------------------------- D. SMS dry-run through the UI + simulated inbound
  console.log('D. SMS dry-run and simulated inbound through the UI');
  {
    const { ctx, page } = await newPage(browser);
    await page.goto(url('settings'));
    await ready(page);
    await page.getByLabel('Phone number', { exact: true }).fill('0712 345 678');
    await page.getByRole('button', { name: 'Save number' }).click();
    ok(await see(page, 'Number saved on the server.'), 'UI: number saved message');
    ok(await see(page, /Saved number: \+255 7•/), 'UI: shows masked number');
    ok(!(await page.content()).includes('712345678') && !(await page.content()).includes('712 345 678</'), 'UI: full number not echoed in the page');
    await page.goto(url('alerts'));
    await ready(page);
    await page.getByRole('button', { name: 'Send test SMS' }).click();
    ok(await see(page, 'Not sent (dry run)', 12000), 'UI: test SMS shows "Not sent (dry run)"');
    ok(await page.getByText('Dry run means no Beem credentials').isVisible(), 'UI: explains dry run');
    const sendBtn = page.getByRole('button', { name: 'Send SMS now' }).first();
    if (await sendBtn.count()) { await sendBtn.click(); ok(await until(async () => (await page.getByText('Not sent (dry run)').count()) >= 2), 'UI: alert card SMS shows "Not sent (dry run)"'); }
    const log = (await api('/api/sms/log')).body.log;
    ok(log.some((e) => e.kind === 'test' && e.state === 'dry_run'), 'server log has the test SMS as dry_run');
    // simulated inbound
    const before = (await head()).count;
    await page.goto(url('settings'));
    await ready(page);
    await page.getByLabel('Message', { exact: true }).fill('RIPOTI K2 OKS 5.4 JOTO 27.1');
    await page.getByRole('button', { name: 'Simulate inbound SMS' }).click();
    ok(await see(page, /Understood\. 2 readings/), 'UI: inbound SMS understood (2 readings)');
    ok(await until(async () => (await head()).count === before + 2, 15000), 'inbound draft pulled into the chain and synced (+2 records)', `${(await head()).count} vs ${before + 2}`);
    await page.getByLabel('Message', { exact: true }).fill('RIPOTI K2 OKS 55');
    await page.getByRole('button', { name: 'Simulate inbound SMS' }).click();
    ok(await see(page, /outside the allowed range/), 'UI: out-of-range SMS is rejected with a reason');
    await ctx.close();
    await api('/api/settings', { method: 'PUT', body: { phone: null } });
  }

  // ---------------------------------------------------------------- E. validation and the low-oxygen alert path
  console.log('E. Validation and alert creation');
  {
    const { ctx, page } = await newPage(browser);
    await page.goto(url('record'));
    await ready(page);
    await page.getByLabel('Dissolved oxygen', { exact: true }).fill('55');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    ok(await page.getByText('Please fix these before saving:').isVisible(), 'out-of-range DO is refused with a summary');
    await page.getByLabel('Dissolved oxygen', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    ok(await page.getByText('Enter at least one value').first().isVisible(), 'empty form is refused (empty is never saved as 0)');
    await page.getByLabel('Cage', { exact: true }).selectOption({ label: 'Cage 1' });
    await recordDo(page, '3.2');
    ok(await see(page, 'New alert'), 'a 3.2 mg/L reading creates a new alert on save');
    ok(await see(page, 'Critical'), 'alert shows the word Critical (not colour alone)');
    await ctx.close();
  }
} finally {
  await browser.close();
  server.child.kill();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
