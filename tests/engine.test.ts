import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyChain } from '../src/core/hashchain';
import type { Reading, ReadingDraft } from '../src/core/types';
import { ApiError, type Api, type SmsSendBody } from '../src/data/api';
import { openAppDb } from '../src/data/db';
import { DEFAULT_SETTINGS, Engine } from '../src/data/engine';
import { createApp } from '../server/app';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { NOW } from './helpers';

let n = 0;
async function makeEngine(over: Partial<Api> = {}) {
  const db = await openAppDb('t-' + n++ + '-' + Math.random());
  const calls = { sync: [] as { farmId: string; ids: string[] }[], sms: [] as SmsSendBody[] };
  const state = { online: true, serverDown: false, hasPhone: true };
  const serverIds = new Map<string, Set<string>>();
  const api: Api = {
    async sync(farmId, records) {
      if (!state.online) throw new ApiError(0, 'offline', true);
      if (state.serverDown) throw new ApiError(0, 'unreachable', true);
      calls.sync.push({ farmId, ids: records.map((r) => r.id) });
      const set = serverIds.get(farmId) ?? serverIds.set(farmId, new Set()).get(farmId)!;
      let accepted = 0, duplicates = 0;
      for (const r of records) (set.has(r.id) ? duplicates++ : (set.add(r.id), accepted++));
      return { accepted, duplicates, conflicts: [], chain: { ok: true, count: set.size, headHash: 'h' }, checkpoint: { receivedAt: new Date(NOW).toISOString(), farmId, headHash: 'h', headSeq: set.size, count: set.size, chainOk: true } };
    },
    async sendSms(body) {
      if (!state.online) throw new ApiError(0, 'offline', true);
      calls.sms.push(body);
      if (!state.hasPhone) throw new ApiError(400, 'no_phone');
      return { state: 'dry_run', requestId: body.requestId, dryRun: true };
    },
    async inbox() { if (!state.online) throw new ApiError(0, 'offline', true); return { items: [] }; },
    async ackInbox() {},
    async weather() { throw new ApiError(0, 'unreachable', true); },
    async settings() { throw new ApiError(0, 'unreachable', true); },
    ...over,
  };
  const engine = new Engine({ db, api, now: () => NOW, isOnline: () => state.online });
  await engine.init();
  return { engine, db, api, calls, state };
}
const draft = (over: Partial<ReadingDraft> = {}): ReadingDraft => ({ cageId: 'farm-demo-c1', farmId: 'farm-demo', kind: 'do', value: 6.1, unit: 'mg/L', ts: new Date(NOW).toISOString(), source: 'manual', via: 'app', demo: true, ...over });

describe('offline-first engine', () => {
  let ctx: Awaited<ReturnType<typeof makeEngine>>;
  beforeEach(async () => { ctx = await makeEngine(); });

  it('seeds once, and reseeds identically on reset', async () => {
    const a = await ctx.engine.snapshot();
    expect(a.farms).toHaveLength(5);
    expect(a.readings.length).toBeGreaterThan(3000);
    await ctx.engine.init();
    expect((await ctx.engine.snapshot()).readings.length).toBe(a.readings.length);
    await ctx.engine.resetDemo();
    expect((await ctx.engine.snapshot()).readings.length).toBe(a.readings.length);
  });

  it('offline: a reading is saved on the phone and sits in the outbox; nothing is sent', async () => {
    ctx.state.online = false;
    const [r] = await ctx.engine.record('farm-demo', [draft()]);
    const s = await ctx.engine.snapshot();
    expect(s.readings.some((x) => x.id === r!.id)).toBe(true);
    expect(s.pending.readings).toBe(1);
    expect(await ctx.engine.sync()).toMatchObject({ status: 'offline' });
    expect(ctx.calls.sync).toHaveLength(0);
    expect((await ctx.engine.snapshot()).pending.readings).toBe(1);
  });

  it('back online: sync sends it, the outbox empties, and a re-sync sends nothing (idempotent)', async () => {
    ctx.state.online = false;
    const [r] = await ctx.engine.record('farm-demo', [draft()]);
    ctx.state.online = true;
    const first = await ctx.engine.sync();
    expect(first.status).toBe('ok');
    expect(ctx.calls.sync.flatMap((c) => c.ids)).toContain(r!.id);
    expect((await ctx.engine.snapshot()).pending.readings).toBe(0);
    const before = ctx.calls.sync.length;
    await ctx.engine.sync();
    expect(ctx.calls.sync.length).toBe(before);
    // Sending the same record again is harmless for the server.
    const dupe = await ctx.api.sync('farm-demo', [r!]);
    expect(dupe).toMatchObject({ accepted: 0, duplicates: 1 });
  });

  it('first sync sends each farm whole chain in order; later syncs send only what is pending', async () => {
    await ctx.engine.sync();
    const s = await ctx.engine.snapshot();
    const demoSent = ctx.calls.sync.filter((c) => c.farmId === 'farm-demo').flatMap((c) => c.ids);
    expect(demoSent.length).toBe(s.readings.filter((r) => r.farmId === 'farm-demo').length);
    expect(Object.keys(s.chainSync).sort()).toEqual(s.farms.map((f) => f.id).sort());
    ctx.calls.sync.length = 0;
    await ctx.engine.record('farm-demo', [draft(), draft({ kind: 'temp', value: 27, unit: '°C' })]);
    await ctx.engine.sync();
    expect(ctx.calls.sync).toHaveLength(1);
    expect(ctx.calls.sync[0]!.ids).toHaveLength(2);
  });

  it('a server that is down keeps everything queued and reports it plainly', async () => {
    await ctx.engine.sync();
    await ctx.engine.record('farm-demo', [draft()]);
    ctx.state.serverDown = true;
    const r = await ctx.engine.sync();
    expect(r.status).toBe('unreachable');
    expect((await ctx.engine.snapshot()).pending.readings).toBe(1);
    ctx.state.serverDown = false;
    expect((await ctx.engine.sync()).status).toBe('ok');
    expect((await ctx.engine.snapshot()).pending.readings).toBe(0);
  });

  it('records keep an unbroken hash chain, even when saves overlap', async () => {
    await Promise.all([1, 2, 3, 4, 5, 6].map((i) => ctx.engine.record('farm-demo', [draft({ value: 5 + i / 10 })])));
    const s = await ctx.engine.snapshot();
    const chain = s.readings.filter((r) => r.farmId === 'farm-demo');
    expect(await verifyChain(chain)).toMatchObject({ ok: true });
    expect(new Set(chain.map((r) => r.seq)).size).toBe(chain.length);
  });

  it('SMS requests queue while offline and resolve to Not sent (dry run) later', async () => {
    ctx.state.online = false;
    await ctx.engine.queueSms({ kind: 'alert', lang: 'sw', template: 'do_critical', params: { cage: 3, value: 3.8 }, requestId: 'r1', alertId: 'a1' });
    let s = await ctx.engine.snapshot();
    expect(s.pending.sms).toBe(1);
    expect(s.alertSms.a1!.state).toBe('queued');
    ctx.state.online = true;
    await ctx.engine.sync();
    s = await ctx.engine.snapshot();
    expect(s.pending.sms).toBe(0);
    expect(s.alertSms.a1!.state).toBe('dry_run');
  });
  it('an SMS with no saved number is failed with a reason, not retried forever', async () => {
    ctx.state.hasPhone = false;
    await ctx.engine.queueSms({ kind: 'alert', lang: 'en', template: 'do_watch', params: { cage: 1, value: 4.5 }, requestId: 'r2', alertId: 'a2' });
    await ctx.engine.sync();
    const s = await ctx.engine.snapshot();
    expect(s.pending.sms).toBe(0);
    expect(s.alertSms.a2).toMatchObject({ state: 'failed', error: 'no_phone' });
  });
  it('respects alert-type SMS toggles', async () => {
    const alert = { id: 'x', farmId: 'farm-demo', cageId: 'farm-demo-c3', rule: 'do', severity: 'critical', peak: 'critical', firstFiredAt: new Date(NOW).toISOString(), active: true, params: { value: 3.8 } } as const;
    expect(await ctx.engine.queueAlertSms(alert as any, 3, { ...DEFAULT_SETTINGS, smsAlertTypes: { ...DEFAULT_SETTINGS.smsAlertTypes, do: false } })).toBe(false);
    expect(await ctx.engine.queueAlertSms(alert as any, 3, DEFAULT_SETTINGS)).toBe(true);
    expect((await ctx.engine.snapshot()).pending.sms).toBe(1);
  });
  it('inbound SMS drafts join the local chain with via sms, idempotently', async () => {
    const item = { id: 'in-1', receivedAt: new Date(NOW).toISOString(), draft: draft({ via: 'sms', kind: 'do', value: 5.2 }) };
    let acked: string[] = [];
    const c = await makeEngine({ async inbox() { return { items: [item] }; }, async ackInbox(ids) { acked = ids; } });
    await c.engine.sync();
    await c.engine.sync();
    const rs = (await c.engine.snapshot()).readings.filter((r: Reading) => r.via === 'sms');
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ id: 'in-1', source: 'manual', value: 5.2 });
    expect(acked).toEqual(['in-1']);
  });
});

describe('engine against the real server code (no network beyond localhost)', () => {
  it('sync end to end: seeded farms arrive, chains verify on the server, a new reading is checkpointed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'e2e-'));
    const clock = { t: NOW };
    const { app } = createApp({ dataDir, env: {}, now: () => clock.t });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const j = async (m: string, p: string, b?: unknown) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return r.json() as Promise<any>; };
      const api: Api = {
        sync: (farmId, records) => j('POST', '/api/sync', { farmId, records }),
        sendSms: (b) => j('POST', '/api/sms/send', b),
        inbox: () => j('GET', '/api/inbox'), ackInbox: async (ids) => void (await j('POST', '/api/inbox/ack', { ids })),
        weather: (lat, lon) => j('GET', `/api/box/weather?lat=${lat}&lon=${lon}`), settings: () => j('GET', '/api/settings'),
      };
      const db = await openAppDb('e2e-' + Math.random());
      const engine = new Engine({ db, api, now: () => NOW, isOnline: () => true });
      await engine.init();
      expect((await engine.sync()).status).toBe('ok');
      const snap = await engine.snapshot();
      expect(snap.forecast).toMatchObject({ mode: 'demo' });
      expect(snap.chainSync['farm-demo']!.chain.ok).toBe(true);
      expect(snap.chainSync['farm-salma']).toMatchObject({ chain: { ok: false, brokenAtSeq: 57 }, checkpoint: { chainOk: false } }); // the server sees the demo break too
      clock.t += 5 * 60_000;
      await engine.record('farm-demo', [draft()]);
      await engine.sync();
      const cps = (await j('GET', '/api/checkpoints?farmId=farm-demo')).checkpoints;
      const localCount = (await engine.snapshot()).readings.filter((x) => x.farmId === 'farm-demo').length;
      expect(cps[0]).toMatchObject({ count: localCount, chainOk: true });
      expect(cps.length).toBeGreaterThanOrEqual(2);
      // Simulated inbound SMS goes server inbox -> local chain
      expect((await j('POST', '/api/sms/inbound', { text: 'REPORT C2 DO 5.5 PH 7.2' })).queued).toBe(2);
      const r = await engine.sync();
      expect(r.pulledInbound).toBe(2);
      expect((await engine.snapshot()).readings.filter((x) => x.via === 'sms')).toHaveLength(2);
    } finally {
      server.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('sync conflicts are never dropped silently', () => {
  it('keeps a refused reading in the outbox and reports it', async () => {
    let refuse = false;
    const ctx = await makeEngine();
    const orig = ctx.api.sync;
    ctx.api.sync = async (farmId, records) => {
      const r = await orig(farmId, records);
      return refuse ? { ...r, accepted: 0, conflicts: records.map((x) => x.id) } : r;
    };
    await ctx.engine.sync();
    const saved = await ctx.engine.record('farm-demo', [draft({ value: 5.5 })]);
    refuse = true;
    const res = await ctx.engine.sync();
    expect(res.conflicts).toBe(1);
    expect((await ctx.engine.snapshot()).pending.readings).toBe(1);
    refuse = false;
    await ctx.engine.sync();
    expect((await ctx.engine.snapshot()).pending.readings).toBe(0);
    expect(saved).toHaveLength(1);
  });
});
