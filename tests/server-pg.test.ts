import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { buildChain } from '../src/core/hashchain';
import { PgStore } from '../server/store/pg';
import { readMigrations } from '../server/store';
import type { ReadingDraft } from '../src/core/types';

/**
 * The real routes, over a real Postgres. The store contract test proves the two stores agree; this proves
 * the server actually works on top of the Postgres one — the async wrapper, the settings singleton, the
 * idempotent sync and the delivery-report callback all the way through HTTP.
 *
 *   docker compose up -d
 *   TEST_DATABASE_URL=postgres://ziwadata:localdev@127.0.0.1:5434/ziwadata npm test
 *
 * Skipped when TEST_DATABASE_URL is unset, so `npm test` passes with nothing installed.
 */
const PG_URL = process.env.TEST_DATABASE_URL;
const maybe = PG_URL ? describe : describe.skip;

const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  vi.restoreAllMocks();
});

async function start(env: Record<string, string | undefined> = {}, fetchImpl?: typeof fetch) {
  const store = new PgStore(PG_URL!);
  await store.migrate(readMigrations());
  await store.resetAll();
  closers.push(() => store.close());

  const clock = { t: Date.parse('2026-09-29T06:10:00Z') };
  const { app } = createApp({ dataDir: '/tmp/unused-by-pg', store, env, now: () => clock.t, sleep: async () => {}, fetchImpl });
  const server = app.listen(0);
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  return { store, call, clock, base };
}

const draft = (i: number): ReadingDraft => ({
  cageId: 'farm-demo-c1', farmId: 'farm-demo', kind: 'do', value: 5 + i / 10, unit: 'mg/L',
  ts: new Date(Date.UTC(2026, 8, 1, i)).toISOString(), source: 'manual', via: 'app', demo: true,
});

maybe('the server on Postgres', () => {
  it('syncs a chain, verifies it and writes a checkpoint', async () => {
    const s = await start();
    const chain = await buildChain([draft(0), draft(1), draft(2)]);
    const r = await s.call('POST', '/api/sync', { farmId: 'farm-demo', records: chain });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ accepted: 3, duplicates: 0, chain: { ok: true, count: 3 } });
    expect(r.body.checkpoint).toMatchObject({ farmId: 'farm-demo', headHash: chain[2]!.hash, headSeq: 3, chainOk: true });

    // Idempotent by record id: re-sending changes nothing and adds no checkpoint.
    const again = await s.call('POST', '/api/sync', { farmId: 'farm-demo', records: chain });
    expect(again.body).toMatchObject({ accepted: 0, duplicates: 3, chain: { ok: true, count: 3 } });
    expect((await s.call('GET', '/api/checkpoints?farmId=farm-demo')).body.checkpoints).toHaveLength(1);
  });

  it('survives a server restart: the chain is still there and still verifies', async () => {
    const first = await start();
    const chain = await buildChain([draft(0), draft(1)]);
    await first.call('POST', '/api/sync', { farmId: 'farm-demo', records: chain });

    // A second app on the same database, as if the process had been restarted.
    const store = new PgStore(PG_URL!);
    closers.push(() => store.close());
    const { app } = createApp({ dataDir: '/tmp/unused-by-pg', store, env: {}, now: () => Date.parse('2026-09-29T07:00:00Z') });
    const server = app.listen(0);
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ farmId: 'farm-demo', records: chain }) });
    expect(await res.json()).toMatchObject({ accepted: 0, duplicates: 2, chain: { ok: true, count: 2 } });
  });

  it('saves a phone number and only ever returns it masked', async () => {
    const s = await start();
    const r = await s.call('PUT', '/api/settings', { phone: '0712345678' });
    expect(r.body).toMatchObject({ hasPhone: true, phoneMasked: '+255 7•• ••• 678' });
    expect(JSON.stringify(r.body)).not.toContain('255712345678');
    expect((await s.call('GET', '/api/settings')).body).toMatchObject({ hasPhone: true, smsLang: 'sw' });
  });

  it('records a dry-run SMS and is idempotent by requestId', async () => {
    const s = await start();
    await s.call('PUT', '/api/settings', { phone: '0712345678' });
    const a = await s.call('POST', '/api/sms/send', { kind: 'test', lang: 'sw', requestId: 't1' });
    expect(a.body).toMatchObject({ state: 'dry_run', dryRun: true });
    const b = await s.call('POST', '/api/sms/send', { kind: 'test', lang: 'sw', requestId: 't1' });
    expect(b.body).toMatchObject({ state: 'dry_run', duplicate: true });
    const log = (await s.call('GET', '/api/sms/log')).body.log;
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log)).not.toContain('712345678');
  });

  it('takes a delivery report through the callback and shows it in the log', async () => {
    const env = { BEEM_API_KEY: 'k', BEEM_SECRET_KEY: 's', BEEM_SENDER_ID: 'SENDER' };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ successful: true, request_id: 77, code: 100 }), { status: 200 }));
    const s = await start(env, fetchImpl as any);
    await s.call('PUT', '/api/settings', { phone: '0712345678' });
    await s.call('POST', '/api/sms/send', { kind: 'alert', lang: 'sw', template: 'do_critical', params: { cage: 3, value: 3.8 }, requestId: 'a1', alertId: 'alert-1' });

    const res = await fetch(`${s.base}/api/sms/dlr`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ DLRID: '77', STATUS: '1' }).toString() });
    expect(await res.json()).toEqual({ ok: true, matched: true });

    const entry = (await s.call('GET', '/api/sms/log')).body.log.find((e: any) => e.id === 'a1');
    expect(entry.state).toBe('sent');
    expect(entry.delivery).toMatchObject({ state: 'delivered', raw: '1 Delivered', via: 'callback' });
  });

  it('queues an inbound SMS draft and acknowledges it', async () => {
    const s = await start();
    const r = await s.call('POST', '/api/sms/inbound', { text: 'RIPOTI K3 OKS 5.2 JOTO 27.5' });
    expect(r.body).toMatchObject({ ok: true, queued: 2 });
    const items = (await s.call('GET', '/api/inbox')).body.items;
    expect(items).toHaveLength(2);
    expect((await s.call('POST', '/api/inbox/ack', { ids: [items[0].id] })).body).toEqual({ remaining: 1 });
  });

  it('a failing store returns 500 instead of hanging the request', async () => {
    const s = await start();
    // Express 4 does not forward a rejected promise on its own; the wrapper in createApp does.
    vi.spyOn(s.store, 'getSettings').mockRejectedValue(new Error('database is gone'));
    const r = await s.call('GET', '/api/settings');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'server_error' }); // never echoes the internal message
  });

  it('demo reset clears the records but keeps the phone number', async () => {
    const s = await start();
    await s.call('PUT', '/api/settings', { phone: '0712345678' });
    await s.call('POST', '/api/sync', { farmId: 'farm-demo', records: await buildChain([draft(0)]) });
    await s.call('POST', '/api/demo/reset');
    expect(await s.store.getRecords('farm-demo')).toEqual([]);
    expect((await s.call('GET', '/api/settings')).body).toMatchObject({ hasPhone: true });
  });
});
