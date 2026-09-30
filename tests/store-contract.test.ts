import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildChain, verifyChain } from '../src/core/hashchain';
import type { Checkpoint, ReadingDraft } from '../src/core/types';
import { JsonStore } from '../server/store/json';
import { PgStore } from '../server/store/pg';
import { readMigrations } from '../server/store';
import type { AppStore, SmsLogEntry } from '../server/store/types';

/**
 * ONE set of assertions, run against BOTH stores. The point is that swapping the backing store changes
 * nothing a route can observe, so the JSON store stays a faithful fake for the Postgres one.
 *
 * The Postgres half needs a database. Start it with `docker compose up -d`, then:
 *   TEST_DATABASE_URL=postgres://ziwadata:localdev@127.0.0.1:5434/ziwadata npm test
 * Without that variable the Postgres cases are skipped, so `npm test` still passes with nothing installed.
 */
const PG_URL = process.env.TEST_DATABASE_URL;

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const draft = (i: number, over: Partial<ReadingDraft> = {}): ReadingDraft => ({
  cageId: 'farm-demo-c1', farmId: 'farm-demo', kind: 'do', value: 5 + i / 10, unit: 'mg/L',
  ts: new Date(Date.UTC(2026, 8, 1, i)).toISOString(), source: 'manual', via: 'app', demo: true, ...over,
});
const sms = (over: Partial<SmsLogEntry> = {}): SmsLogEntry => ({
  id: 's1', at: '2026-09-29T06:10:00.000Z', kind: 'alert', state: 'sent', lang: 'sw', chars: 90, ...over,
});
const cp = (over: Partial<Checkpoint> = {}): Checkpoint => ({
  receivedAt: '2026-09-29T06:10:00.000Z', farmId: 'farm-demo', headHash: 'a'.repeat(64), headSeq: 1, count: 1, chainOk: true, ...over,
});

type Backend = { name: string; make: () => Promise<AppStore> };
const backends: Backend[] = [
  {
    name: 'JsonStore',
    make: async () => {
      const dir = mkdtempSync(join(tmpdir(), 'store-json-'));
      dirs.push(dir);
      return new JsonStore(dir);
    },
  },
];
if (PG_URL) {
  backends.push({
    name: 'PgStore',
    make: async () => {
      const s = new PgStore(PG_URL);
      await s.migrate(readMigrations());
      closers.push(() => s.close());
      // A fresh JsonStore starts empty; Postgres must start each case empty too, accounts included.
      await s.resetAll();
      return s;
    },
  });
} else {
  // Visible in the run, so a skipped Postgres suite is never mistaken for a passing one.
  describe.skip('PgStore (set TEST_DATABASE_URL and run docker compose up -d to include it)', () => {
    it('skipped', () => { /* not run */ });
  });
}

describe.each(backends)('$name behaves the same', ({ make }) => {
  let store: AppStore;
  beforeEach(async () => {
    store = await make();
    await store.resetAll();
  });

  // ---- Records ----
  it('accepts a chain and returns it in seq order', async () => {
    const chain = await buildChain([draft(0), draft(1), draft(2)]);
    const r = await store.syncRecords('farm-demo', chain);
    expect(r).toMatchObject({ accepted: 3, duplicates: 0, conflicts: [] });
    expect(r.list.map((x) => x.seq)).toEqual([1, 2, 3]);
  });

  it('is idempotent by record id', async () => {
    const chain = await buildChain([draft(0), draft(1)]);
    await store.syncRecords('farm-demo', chain);
    const again = await store.syncRecords('farm-demo', chain);
    expect(again).toMatchObject({ accepted: 0, duplicates: 2, conflicts: [] });
    expect(again.list).toHaveLength(2);
  });

  it('refuses a second record claiming a position another already holds', async () => {
    const chain = await buildChain([draft(0)]);
    await store.syncRecords('farm-demo', chain);
    // buildChain gives deterministic ids, so a genuine rival needs an explicit one: a second phone that
    // generated its own record id for the same position in the chain.
    const rival = await buildChain([draft(5, { id: 'farm-demo-second-phone' })]);
    expect(rival[0]!.seq).toBe(1);
    expect(rival[0]!.id).not.toBe(chain[0]!.id);
    const r = await store.syncRecords('farm-demo', rival);
    expect(r).toMatchObject({ accepted: 0, duplicates: 0, conflicts: [rival[0]!.id] });
    // The record that was already there is untouched, never overwritten.
    expect(r.list).toHaveLength(1);
    expect(r.list[0]!.id).toBe(chain[0]!.id);
  });

  it('keeps farms apart', async () => {
    await store.syncRecords('farm-a', await buildChain([draft(0, { farmId: 'farm-a' })]));
    await store.syncRecords('farm-b', await buildChain([draft(0, { farmId: 'farm-b' })]));
    expect(await store.getRecords('farm-a')).toHaveLength(1);
    expect(await store.getRecords('farm-b')).toHaveLength(1);
  });

  /**
   * The one that matters. A record must come back byte-identical to what was hashed, or the lender screen
   * reports a broken chain that never happened. This is why readings are stored as canonical JSON text and
   * not as jsonb, which would reorder the keys and reformat the numbers.
   */
  it('round-trips a chain so it still verifies, including a whole number written as 5.0', async () => {
    const chain = await buildChain([
      draft(0, { value: 5.0 }),          // JSON.stringify -> "5";  Python json.dumps -> "5.0"
      draft(1, { value: 7.25 }),
      draft(2, { kind: 'incident', value: 'storm', unit: '' }),
      draft(3, { value: 6.1, note: 'after the rain', attested: true, source: 'sensor', deviceId: 'demo-ws-1' }),
    ]);
    expect((await verifyChain(chain)).ok).toBe(true);

    const { list } = await store.syncRecords('farm-demo', chain);
    const back = await verifyChain(list);
    expect(back.ok).toBe(true);
    expect(back.brokenAtSeq).toBeUndefined();
    // Not just verifiable: identical, field for field, including optional fields that must stay absent.
    expect(list).toEqual(chain);
    expect(Object.prototype.hasOwnProperty.call(list[0]!, 'note')).toBe(false);
  });

  // ---- Checkpoints ----
  it('returns the newest checkpoint per farm and lists newest first', async () => {
    await store.addCheckpoint(cp({ headSeq: 1 }));
    await store.addCheckpoint(cp({ headSeq: 2, headHash: 'b'.repeat(64) }));
    await store.addCheckpoint(cp({ farmId: 'other', headSeq: 9 }));
    expect((await store.latestCheckpoint('farm-demo'))!.headSeq).toBe(2);
    expect((await store.listCheckpoints('farm-demo', 50)).map((c) => c.headSeq)).toEqual([2, 1]);
    expect(await store.listCheckpoints('nobody', 50)).toEqual([]);
    expect(await store.latestCheckpoint('nobody')).toBeNull();
  });
  it('keeps brokenAtSeq absent when the chain is whole', async () => {
    await store.addCheckpoint(cp());
    expect(Object.prototype.hasOwnProperty.call((await store.latestCheckpoint('farm-demo'))!, 'brokenAtSeq')).toBe(false);
    await store.addCheckpoint(cp({ chainOk: false, brokenAtSeq: 57 }));
    expect((await store.latestCheckpoint('farm-demo'))!.brokenAtSeq).toBe(57);
  });

  // ---- Settings ----
  it('saves, changes and clears the phone number', async () => {
    expect((await store.getSettings()).phone).toBeUndefined();
    await store.putSettings({ phone: '255712345678' });
    expect((await store.getSettings()).phone).toBe('255712345678');
    await store.putSettings({ smsLang: 'en' });
    expect(await store.getSettings()).toMatchObject({ phone: '255712345678', smsLang: 'en' });
    await store.putSettings({ clearPhone: true });
    expect((await store.getSettings()).phone).toBeUndefined();
    expect((await store.getSettings()).smsLang).toBe('en'); // clearing the phone leaves the language alone
  });

  // ---- SMS ----
  it('stores an SMS entry without inventing optional fields', async () => {
    await store.addSms(sms({ id: 'a1' }));
    const got = (await store.getSms('a1'))!;
    expect(got).toMatchObject({ id: 'a1', at: '2026-09-29T06:10:00.000Z', kind: 'alert', state: 'sent', chars: 90 });
    for (const k of ['alertId', 'error', 'beemRequestId', 'delivery']) expect(Object.prototype.hasOwnProperty.call(got, k)).toBe(false);
    expect(await store.getSms('nope')).toBeNull();
  });
  it('lists newest first even when every entry shares a timestamp', async () => {
    for (const id of ['a', 'b', 'c']) await store.addSms(sms({ id }));
    expect((await store.listSms(50)).map((e) => e.id)).toEqual(['c', 'b', 'a']);
    expect((await store.listSms(2)).map((e) => e.id)).toEqual(['c', 'b']);
  });
  it('counts only the states asked for, strictly after the given time', async () => {
    await store.addSms(sms({ id: 'a', state: 'sent', at: '2026-09-29T06:00:00.000Z' }));
    await store.addSms(sms({ id: 'b', state: 'failed', at: '2026-09-29T07:00:00.000Z' }));
    await store.addSms(sms({ id: 'c', state: 'dry_run', at: '2026-09-29T07:00:00.000Z' }));
    expect(await store.countSmsSince('2026-09-29T05:00:00.000Z', ['sent', 'failed'])).toBe(2);
    expect(await store.countSmsSince('2026-09-29T06:00:00.000Z', ['sent', 'failed'])).toBe(1);
    expect(await store.countSmsSince('2026-09-29T05:00:00.000Z', ['dry_run'])).toBe(1);
  });
  it('matches a delivery report on Beem\'s id or on ours, newest first', async () => {
    await store.addSms(sms({ id: 'old', beemRequestId: '77' }));
    await store.addSms(sms({ id: 'new', beemRequestId: '77' }));
    expect((await store.findSmsForDlr('77'))!.id).toBe('new');
    expect((await store.findSmsForDlr('old'))!.id).toBe('old');
    expect(await store.findSmsForDlr('nobody')).toBeNull();
  });
  it('records a delivery state and stops treating the message as pending', async () => {
    await store.addSms(sms({ id: 'a', beemRequestId: '77' }));
    expect((await store.pendingDeliveries(10)).map((e) => e.id)).toEqual(['a']);
    await store.setSmsDelivery('a', { state: 'delivered', raw: '1 Delivered', at: '2026-09-29T06:20:00.000Z', via: 'callback' });
    expect((await store.getSms('a'))!.delivery).toEqual({ state: 'delivered', raw: '1 Delivered', at: '2026-09-29T06:20:00.000Z', via: 'callback' });
    expect(await store.pendingDeliveries(10)).toEqual([]);
  });
  it('only asks about messages that were really sent and still have no verdict', async () => {
    await store.addSms(sms({ id: 'dry', state: 'dry_run' }));                       // never sent
    await store.addSms(sms({ id: 'no-id', state: 'sent' }));                        // no Beem id to ask about
    await store.addSms(sms({ id: 'ok', state: 'sent', beemRequestId: '1' }));
    await store.addSms(sms({ id: 'waiting', state: 'sent', beemRequestId: '2' }));
    await store.setSmsDelivery('waiting', { state: 'pending', raw: '2 In process', at: '2026-09-29T06:20:00.000Z', via: 'poll' });
    expect((await store.pendingDeliveries(10)).map((e) => e.id)).toEqual(['ok', 'waiting']);
  });

  // ---- Inbox ----
  it('queues drafts in order and acknowledges them', async () => {
    await store.addInbox([
      { id: 'in-1', receivedAt: '2026-09-29T06:10:00.000Z', draft: draft(0) },
      { id: 'in-2', receivedAt: '2026-09-29T06:10:00.000Z', draft: draft(1, { kind: 'temp', value: 27.5, unit: '°C' }) },
    ]);
    const items = await store.listInbox();
    expect(items.map((i) => i.id)).toEqual(['in-1', 'in-2']);
    expect(items[1]!.draft).toMatchObject({ kind: 'temp', value: 27.5 });
    expect(await store.ackInbox(['in-1'])).toBe(1);
    expect((await store.listInbox()).map((i) => i.id)).toEqual(['in-2']);
    expect(await store.ackInbox([])).toBe(1);
  });

  // ---- Unmatched delivery reports ----
  it('keeps a report it could not match', async () => {
    await store.addUnmatchedDlr({ at: '2026-09-29T06:10:00.000Z', dlrId: 'nobody', raw: '1 Delivered' });
    await store.addUnmatchedDlr({ at: '2026-09-29T06:11:00.000Z', dlrId: null, raw: 'WAT' });
    expect(await store.listUnmatchedDlr()).toEqual([
      { at: '2026-09-29T06:10:00.000Z', dlrId: 'nobody', raw: '1 Delivered' },
      { at: '2026-09-29T06:11:00.000Z', dlrId: null, raw: 'WAT' },
    ]);
  });

  // ---- Admin ----
  it('reset clears the records but keeps the saved phone number', async () => {
    await store.syncRecords('farm-demo', await buildChain([draft(0)]));
    await store.addSms(sms());
    await store.addCheckpoint(cp());
    await store.addInbox([{ id: 'in-1', receivedAt: '2026-09-29T06:10:00.000Z', draft: draft(0) }]);
    await store.putSettings({ phone: '255712345678', smsLang: 'en' });

    await store.reset();

    expect(await store.getRecords('farm-demo')).toEqual([]);
    expect(await store.listSms(50)).toEqual([]);
    expect(await store.listCheckpoints(null, 50)).toEqual([]);
    expect(await store.listInbox()).toEqual([]);
    expect(await store.getSettings()).toMatchObject({ phone: '255712345678', smsLang: 'en' });
  });

  it('describe never leaks a credential', async () => {
    expect(store.describe()).not.toMatch(/localdev|password/i);
  });

  // ---- Accounts ----
  it('creates a user and finds them by number', async () => {
    const u = await store.createUser({ id: 'u1', phone: '255712345678', role: 'farmer', createdAt: '2026-09-29T06:10:00.000Z', disabled: false });
    expect(u).toMatchObject({ id: 'u1', phone: '255712345678', role: 'farmer', disabled: false });
    expect((await store.findUserByPhone('255712345678'))!.id).toBe('u1');
    expect((await store.getUser('u1'))!.role).toBe('farmer');
    expect(await store.findUserByPhone('255700000000')).toBeNull();
    expect(await store.getUser('nope')).toBeNull();
    // Optional fields stay absent rather than null, so the API shape does not change with the backend.
    for (const k of ['lastSeenAt', 'consentAt', 'consentVersion']) expect(Object.prototype.hasOwnProperty.call(u, k)).toBe(false);
  });
  it('records consent with a timestamp and a version', async () => {
    await store.createUser({ id: 'u1', phone: '255712345678', role: 'farmer', createdAt: '2026-09-29T06:10:00.000Z', disabled: false });
    await store.setConsent('u1', '2026-09-29T07:00:00.000Z', 'v1');
    expect(await store.getUser('u1')).toMatchObject({ consentAt: '2026-09-29T07:00:00.000Z', consentVersion: 'v1' });
  });

  // ---- One-time codes ----
  it('keeps one live code per number and still counts the retired ones', async () => {
    const mk = (n: number) => ({ id: '', phone: '255712345678', codeHash: `h${n}`, createdAt: `2026-09-29T06:1${n}:00.000Z`, expiresAt: '2026-09-29T07:00:00.000Z', attempts: 0 });
    await store.putCode(mk(0));
    await store.putCode(mk(1));
    expect((await store.liveCode('255712345678', '2026-09-29T06:20:00.000Z'))!.codeHash).toBe('h1');
    // Retiring the old code must NOT delete it: the hourly rate limit counts these rows.
    expect(await store.countCodesSince('255712345678', '2026-09-29T06:00:00.000Z')).toBe(2);
    expect(await store.lastCodeAt('255712345678')).toBe('2026-09-29T06:11:00.000Z');
  });
  it('treats an expired or consumed code as gone', async () => {
    await store.putCode({ id: '', phone: '255712345678', codeHash: 'h', createdAt: '2026-09-29T06:10:00.000Z', expiresAt: '2026-09-29T06:20:00.000Z', attempts: 0 });
    expect(await store.liveCode('255712345678', '2026-09-29T06:30:00.000Z')).toBeNull(); // expired
    const live = (await store.liveCode('255712345678', '2026-09-29T06:15:00.000Z'))!;
    expect(live.codeHash).toBe('h');
    await store.consumeCode(live.id, '2026-09-29T06:16:00.000Z');
    expect(await store.liveCode('255712345678', '2026-09-29T06:17:00.000Z')).toBeNull();
  });
  it('counts wrong guesses', async () => {
    await store.putCode({ id: '', phone: '255712345678', codeHash: 'h', createdAt: '2026-09-29T06:10:00.000Z', expiresAt: '2026-09-29T07:00:00.000Z', attempts: 0 });
    const live = (await store.liveCode('255712345678', '2026-09-29T06:15:00.000Z'))!;
    expect(await store.bumpCodeAttempts(live.id)).toBe(1);
    expect(await store.bumpCodeAttempts(live.id)).toBe(2);
    expect((await store.liveCode('255712345678', '2026-09-29T06:15:00.000Z'))!.attempts).toBe(2);
  });

  // ---- Sessions ----
  it('finds a live session with its user, and forgets an expired one', async () => {
    await store.createUser({ id: 'u1', phone: '255712345678', role: 'lender', createdAt: '2026-09-29T06:10:00.000Z', disabled: false });
    await store.createSession({ tokenHash: 'th', userId: 'u1', createdAt: '2026-09-29T06:10:00.000Z', expiresAt: '2026-09-29T08:00:00.000Z', lastSeenAt: '2026-09-29T06:10:00.000Z' });
    const found = (await store.findSession('th', '2026-09-29T07:00:00.000Z'))!;
    expect(found.user).toMatchObject({ id: 'u1', role: 'lender' });
    expect(await store.findSession('th', '2026-09-29T09:00:00.000Z')).toBeNull(); // expired
    expect(await store.findSession('nope', '2026-09-29T07:00:00.000Z')).toBeNull();
    await store.touchSession('th', '2026-09-29T07:00:00.000Z');
    expect((await store.findSession('th', '2026-09-29T07:30:00.000Z'))!.session.lastSeenAt).toBe('2026-09-29T07:00:00.000Z');
    await store.deleteSession('th');
    expect(await store.findSession('th', '2026-09-29T07:00:00.000Z')).toBeNull();
  });
  it('drops only the sessions that have run out', async () => {
    await store.createUser({ id: 'u1', phone: '255712345678', role: 'farmer', createdAt: '2026-09-29T06:10:00.000Z', disabled: false });
    await store.createSession({ tokenHash: 'old', userId: 'u1', createdAt: '2026-09-29T06:10:00.000Z', expiresAt: '2026-09-29T06:30:00.000Z', lastSeenAt: '2026-09-29T06:10:00.000Z' });
    await store.createSession({ tokenHash: 'new', userId: 'u1', createdAt: '2026-09-29T06:10:00.000Z', expiresAt: '2026-09-29T09:00:00.000Z', lastSeenAt: '2026-09-29T06:10:00.000Z' });
    expect(await store.deleteExpiredSessions('2026-09-29T07:00:00.000Z')).toBe(1);
    expect(await store.findSession('new', '2026-09-29T07:00:00.000Z')).not.toBeNull();
  });

  // ---- Per-user settings ----
  it('keeps each user\'s number to themselves', async () => {
    for (const id of ['u1', 'u2']) await store.createUser({ id, phone: `2557123456${id === 'u1' ? '78' : '99'}`, role: 'farmer', createdAt: '2026-09-29T06:10:00.000Z', disabled: false });
    await store.putUserSettings('u1', { phone: '255712345678', smsLang: 'en' });
    expect(await store.getUserSettings('u1')).toMatchObject({ phone: '255712345678', smsLang: 'en' });
    expect((await store.getUserSettings('u2')).phone).toBeUndefined();
    await store.putUserSettings('u1', { clearPhone: true });
    expect((await store.getUserSettings('u1')).phone).toBeUndefined();
    expect((await store.getUserSettings('u1')).smsLang).toBe('en');
  });

  it('counts SMS by kind, so sign-in codes do not eat the alert budget', async () => {
    await store.addSms(sms({ id: 'a', kind: 'alert', state: 'sent' }));
    await store.addSms(sms({ id: 'b', kind: 'auth', state: 'sent' }));
    await store.addSms(sms({ id: 'c', kind: 'auth', state: 'sent' }));
    const since = '2026-09-29T05:00:00.000Z';
    expect(await store.countSmsSince(since, ['sent'])).toBe(3);
    expect(await store.countSmsSince(since, ['sent'], ['alert', 'test'])).toBe(1);
    expect(await store.countSmsSince(since, ['sent'], ['auth'])).toBe(2);
  });

  it('a demo reset keeps accounts and sessions: it must not sign everyone out', async () => {
    await store.createUser({ id: 'u1', phone: '255712345678', role: 'farmer', createdAt: '2026-09-29T06:10:00.000Z', disabled: false });
    await store.createSession({ tokenHash: 'th', userId: 'u1', createdAt: '2026-09-29T06:10:00.000Z', expiresAt: '2026-09-29T09:00:00.000Z', lastSeenAt: '2026-09-29T06:10:00.000Z' });
    await store.putUserSettings('u1', { phone: '255712345678' });
    await store.syncRecords('farm-demo', await buildChain([draft(0)]));

    await store.reset();

    expect(await store.getRecords('farm-demo')).toEqual([]);   // demo data is gone
    expect(await store.getUser('u1')).not.toBeNull();          // the account is not
    expect(await store.findSession('th', '2026-09-29T07:00:00.000Z')).not.toBeNull();
    expect((await store.getUserSettings('u1')).phone).toBe('255712345678');
  });
});
