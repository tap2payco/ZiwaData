import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppOptions } from '../server/app';
import { buildChain } from '../src/core/hashchain';
import type { ReadingDraft } from '../src/core/types';

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  closers.splice(0).forEach((c) => c());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

async function start(over: Partial<AppOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'srv-'));
  dirs.push(dataDir);
  const clock = { t: Date.parse('2026-09-29T06:10:00Z') };
  const built = createApp({ dataDir, env: {}, now: () => clock.t, sleep: async () => {}, ...over });
  const server = built.app.listen(0);
  closers.push(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  return { ...built, call, clock, dataDir, base };
}
const draft = (i: number): ReadingDraft => ({ cageId: 'farm-demo-c1', farmId: 'farm-demo', kind: 'do', value: 5 + i / 10, unit: 'mg/L', ts: new Date(Date.UTC(2026, 8, 1, i)).toISOString(), source: 'manual', via: 'app', demo: true });

describe('POST /api/sync', () => {
  it('stores records idempotently by id and records checkpoints', async () => {
    const s = await start();
    const chain = await buildChain(Array.from({ length: 5 }, (_, i) => draft(i)));
    const a = await s.call('POST', '/api/sync', { farmId: 'farm-demo', records: chain });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ accepted: 5, duplicates: 0, chain: { ok: true, count: 5 } });
    expect(a.body.checkpoint).toMatchObject({ farmId: 'farm-demo', headHash: chain[4]!.hash, headSeq: 5, count: 5, chainOk: true, receivedAt: '2026-09-29T06:10:00.000Z' });
    const again = await s.call('POST', '/api/sync', { farmId: 'farm-demo', records: chain });
    expect(again.body).toMatchObject({ accepted: 0, duplicates: 5 });
    const cps = await s.call('GET', '/api/checkpoints?farmId=farm-demo');
    expect(cps.body.checkpoints).toHaveLength(1); // no new checkpoint when the head did not change
    expect(cps.body.latest.headHash).toBe(chain[4]!.hash);
    const more = await buildChain([draft(5)], chain[4]!);
    s.clock.t += 60_000;
    await s.call('POST', '/api/sync', { farmId: 'farm-demo', records: [...chain.slice(3), ...more] });
    expect((await s.call('GET', '/api/checkpoints')).body.checkpoints).toHaveLength(2);
  });
  it('rejects malformed records and flags a broken chain instead of hiding it', async () => {
    const s = await start();
    expect((await s.call('POST', '/api/sync', { farmId: 'farm-demo', records: [{ id: 'x' }] })).status).toBe(400);
    expect((await s.call('POST', '/api/sync', { records: [] })).status).toBe(400);
    const chain = await buildChain(Array.from({ length: 4 }, (_, i) => draft(i)));
    const tampered = chain.map((r) => (r.seq === 2 ? { ...r, value: 9.9 } : r));
    const r = await s.call('POST', '/api/sync', { farmId: 'farm-demo', records: tampered });
    expect(r.body.chain).toMatchObject({ ok: false, brokenAtSeq: 2 });
    expect(r.body.checkpoint).toMatchObject({ chainOk: false, brokenAtSeq: 2 });
  });
  it('persists to server/data and survives a restart', async () => {
    const s = await start();
    const chain = await buildChain([draft(0), draft(1)]);
    await s.call('POST', '/api/sync', { farmId: 'farm-demo', records: chain });
    expect(existsSync(join(s.dataDir, 'db.json'))).toBe(true);
    const s2 = await start({ dataDir: s.dataDir });
    expect((await s2.call('GET', '/api/checkpoints')).body.latest.count).toBe(2);
  });
  it('a corrupt data file does not stop the server', async () => {
    const s = await start();
    writeFileSync(join(s.dataDir, 'db.json'), '{not json');
    const s2 = await start({ dataDir: s.dataDir });
    expect((await s2.call('GET', '/api/health')).body.ok).toBe(true);
  });
});

describe('bad requests', () => {
  it('bad JSON gets a clean 400 and never echoes internals', async () => {
    const s = await start();
    const res = await fetch(s.base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_json' });
  });
});

describe('settings and phone privacy', () => {
  it('validates Tanzanian numbers, stores normalised, returns only a masked number', async () => {
    const s = await start();
    expect((await s.call('PUT', '/api/settings', { phone: '12345' })).status).toBe(400);
    expect((await s.call('PUT', '/api/settings', { phone: '0512345678' })).status).toBe(400);
    const ok = await s.call('PUT', '/api/settings', { phone: '0712 345 678' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ hasPhone: true, phoneMasked: '+255 7•• ••• 678' });
    expect(JSON.stringify(ok.body)).not.toContain('712345678');
    expect((await s.call('GET', '/api/settings')).body.phoneMasked).toContain('678');
    expect((await s.call('PUT', '/api/settings', { phone: '+255 687 654 321' })).status).toBe(200);
    expect((await s.call('PUT', '/api/settings', { phone: null })).body.hasPhone).toBe(false);
  });
});

describe('SMS (dry run without credentials)', () => {
  it('needs a saved number', async () => {
    const s = await start();
    const r = await s.call('POST', '/api/sms/send', { kind: 'test', lang: 'sw', requestId: 'r1' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('no_phone');
  });
  it('records "Not sent (dry run)" and returns that state', async () => {
    const s = await start();
    await s.call('PUT', '/api/settings', { phone: '0712345678' });
    expect((await s.call('GET', '/api/sms/status')).body).toMatchObject({ mode: 'dry-run', live: false });
    const r = await s.call('POST', '/api/sms/send', { kind: 'alert', lang: 'sw', template: 'do_critical', params: { cage: 3, value: 3.8 }, requestId: 'a1', alertId: 'alert-1' });
    expect(r.body).toMatchObject({ state: 'dry_run', dryRun: true, message: 'Tahadhari Kizimba 3: oksijeni 3.8 mg/L (chini). Acha kulisha. Angalia tena baada ya saa 1.' });
    const log = (await s.call('GET', '/api/sms/log')).body.log;
    expect(log[0]).toMatchObject({ id: 'a1', state: 'dry_run', alertId: 'alert-1' });
    expect(JSON.stringify(log)).not.toContain('712345678');
    const dup = await s.call('POST', '/api/sms/send', { kind: 'alert', lang: 'sw', template: 'do_critical', params: { cage: 3, value: 3.8 }, requestId: 'a1' });
    expect(dup.body).toMatchObject({ state: 'dry_run', duplicate: true });
    expect((await s.call('GET', '/api/sms/log')).body.log).toHaveLength(1);
  });
  it('only sends from templates: free text and unknown templates are refused', async () => {
    const s = await start();
    await s.call('PUT', '/api/settings', { phone: '0712345678' });
    expect((await s.call('POST', '/api/sms/send', { kind: 'alert', lang: 'en', template: 'evil', requestId: 'x1' })).status).toBe(400);
    expect((await s.call('POST', '/api/sms/send', { kind: 'alert', lang: 'en', template: 'inbound_ok', requestId: 'x2' })).status).toBe(400);
    expect((await s.call('POST', '/api/sms/send', { kind: 'alert', lang: 'en', message: 'buy now', requestId: 'x3' })).status).toBe(400);
  });
  it('balance check needs credentials', async () => {
    const s = await start();
    expect((await s.call('POST', '/api/sms/balance')).status).toBe(400);
  });
});

describe('SMS with credentials (mocked Beem, nothing leaves the machine)', () => {
  const env = { BEEM_API_KEY: 'k-test', BEEM_API_SECRET: 's-test', BEEM_SENDER_ID: 'SENDER' };
  it('sends to the Beem endpoint with Basic auth, normalised number, encoding 0; never logs details', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ successful: true, request_id: 77, code: 100 }), { status: 200 }));
    const s = await start({ env, fetchImpl: fetchImpl as any });
    await s.call('PUT', '/api/settings', { phone: '0712345678' });
    const r = await s.call('POST', '/api/sms/send', { kind: 'test', lang: 'en', requestId: 't1' });
    expect(r.body).toMatchObject({ state: 'sent', dryRun: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://apisms.beem.africa/v1/send');
    expect((init.headers as any).Authorization).toBe('Basic ' + Buffer.from('k-test:s-test').toString('base64'));
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ source_addr: 'SENDER', encoding: 0, recipients: [{ recipient_id: '1', dest_addr: '255712345678' }] });
    for (const l of logs) for (const call of l.mock.calls) expect(JSON.stringify(call)).not.toMatch(/712345678|k-test|s-test/);
    expect((await s.call('GET', '/api/sms/status')).body).toMatchObject({ mode: 'configured', live: true });
  });
  it('retries with backoff on network errors, then reports failed', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('boom'); });
    const sleeps: number[] = [];
    const s = await start({ env, fetchImpl: fetchImpl as any, sleep: async (ms) => void sleeps.push(ms) });
    await s.call('PUT', '/api/settings', { phone: '0712345678' });
    const r = await s.call('POST', '/api/sms/send', { kind: 'test', lang: 'sw', requestId: 't2' });
    expect(r.body).toMatchObject({ state: 'failed' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect((await s.call('GET', '/api/sms/status')).body.live).toBe(false);
  });
  it.each([101, 102, 104, 109, 111, 120, 123])('does not retry on documented permanent Beem code %i', async (code) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code, message: 'nope' }), { status: 200 }));
    const s = await start({ env, fetchImpl: fetchImpl as any, sleep: async () => {} });
    await s.call('PUT', '/api/settings', { phone: '0712345678' });
    const r = await s.call('POST', '/api/sms/send', { kind: 'test', lang: 'sw', requestId: 't3' });
    expect(r.body.state).toBe('failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('retries Beem code 103, the one documented server error', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 103 }), { status: 200 }));
    const s = await start({ env, fetchImpl: fetchImpl as any, sleep: async () => {} });
    await s.call('PUT', '/api/settings', { phone: '0712345678' });
    expect((await s.call('POST', '/api/sms/send', { kind: 'test', lang: 'sw', requestId: 't3b' })).body.state).toBe('failed');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('rate-limits live sends (no sign-in in the demo)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ successful: true }), { status: 200 }));
    const s = await start({ env: { ...env, SMS_MAX_PER_HOUR: '2' }, fetchImpl: fetchImpl as any });
    await s.call('PUT', '/api/settings', { phone: '0712345678' });
    for (const id of ['a', 'b']) expect((await s.call('POST', '/api/sms/send', { kind: 'test', lang: 'sw', requestId: id })).status).toBe(200);
    expect((await s.call('POST', '/api/sms/send', { kind: 'test', lang: 'sw', requestId: 'c' })).status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('credentials without a sender id fail plainly instead of sending', async () => {
    const fetchImpl = vi.fn();
    const s = await start({ env: { BEEM_API_KEY: 'k', BEEM_SECRET_KEY: 's' }, fetchImpl: fetchImpl as any });
    await s.call('PUT', '/api/settings', { phone: '0712345678' });
    const r = await s.call('POST', '/api/sms/send', { kind: 'test', lang: 'sw', requestId: 't9' });
    expect(r.body).toMatchObject({ state: 'failed', error: 'sender_id_missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('simulated inbound SMS', () => {
  it('turns a valid command into inbox drafts with via sms; client acks them', async () => {
    const s = await start();
    const r = await s.call('POST', '/api/sms/inbound', { text: 'RIPOTI K3 OKS 5.2 JOTO 27.5 PH 7.4' });
    expect(r.body).toMatchObject({ ok: true, simulated: true, queued: 3, reply: 'Imepokelewa Kizimba 3: OKS 5.2, JOTO 27.5, PH 7.4. Asante.' });
    const inbox = (await s.call('GET', '/api/inbox')).body.items;
    expect(inbox).toHaveLength(3);
    expect(inbox[0].draft).toMatchObject({ farmId: 'farm-demo', cageId: 'farm-demo-c3', via: 'sms', source: 'manual', demo: true });
    expect((await s.call('POST', '/api/inbox/ack', { ids: inbox.map((i: any) => i.id) })).body.remaining).toBe(0);
  });
  it('bad input gives a plain error and a reply, and stores nothing', async () => {
    const s = await start();
    for (const [text, error] of [['HELLO', 'unknown_command'], ['REPORT C3 DO 99', 'out_of_range'], ['REPORT C9 DO 5', 'bad_cage']] as const) {
      const r = await s.call('POST', '/api/sms/inbound', { text });
      expect(r.body).toMatchObject({ ok: false, error });
      expect(typeof r.body.reply).toBe('string');
    }
    expect((await s.call('GET', '/api/inbox')).body.items).toHaveLength(0);
    expect((await s.call('POST', '/api/sms/inbound', { text: 5 })).status).toBe(400);
  });
  it('a sender other than the saved number is refused', async () => {
    const s = await start();
    await s.call('PUT', '/api/settings', { phone: '0712345678' });
    expect((await s.call('POST', '/api/sms/inbound', { text: 'REPORT C1 DO 5', from: '0787654321' })).status).toBe(403);
    expect((await s.call('POST', '/api/sms/inbound', { text: 'REPORT C1 DO 5', from: '0712345678' })).body.ok).toBe(true);
  });
});

describe('Box endpoints', () => {
  it('default is demo: no network, demo forecast and devices, nothing is live', async () => {
    const fetchImpl = vi.fn();
    const s = await start({ fetchImpl: fetchImpl as any });
    const st = (await s.call('GET', '/api/box/status')).body;
    expect(st.routes.every((r: any) => r.mode === 'demo' && r.configured === false)).toBe(true);
    const w = (await s.call('GET', '/api/box/weather?lat=-2.52&lon=32.9')).body;
    expect(w.mode).toBe('demo');
    expect(w.forecast).toMatchObject({ source: 'demo', windKmh: 41 });
    const d = (await s.call('GET', '/api/box/devices')).body;
    expect(d).toMatchObject({ mode: 'demo', assumedShape: true });
    expect(d.mapped.devices.map((x: any) => x.type).sort()).toEqual(['water_station', 'water_station', 'weather_station']);
    expect((await s.call('POST', '/api/box/test')).body.routes.every((r: any) => r.mode === 'demo')).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('validates the Box coordinate range', async () => {
    const s = await start();
    expect((await s.call('GET', '/api/box/weather?lat=10&lon=32.9')).status).toBe(400);
    expect((await s.call('GET', '/api/box/weather?lat=-2.5&lon=50')).status).toBe(400);
    expect((await s.call('GET', '/api/box/weather?lat=abc&lon=32')).status).toBe(400);
  });
  it('with an API key, weather uses X-API-Key; Live shows only after a successful call; devices stay demo (Bearer only)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data_day: { time: ['2026-09-30'], windspeed_max: [10], precipitation: [3] }, units: { windspeed: 'ms-1', precipitation: 'mm' } }), { status: 200 }));
    const s = await start({ env: { BOX_API_KEY: 'box-key' }, fetchImpl: fetchImpl as any });
    let st = (await s.call('GET', '/api/box/status')).body;
    expect(st.routes.find((r: any) => r.id === 'water')).toMatchObject({ configured: true, mode: 'demo', lastTest: null });
    expect(st.routes.find((r: any) => r.id === 'devices')).toMatchObject({ configured: false, mode: 'demo' });
    const w = (await s.call('GET', '/api/box/weather')).body;
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.kijanispace.eu/v1/agro_climate/water?lat=-2.52&lon=32.9');
    expect((init.headers as any)['X-API-Key']).toBe('box-key');
    expect(w).toMatchObject({ mode: 'live', forecast: { source: 'live', windKmh: 36, rainMm: 3, unverified: true } });
    st = (await s.call('GET', '/api/box/status')).body;
    expect(st.routes.find((r: any) => r.id === 'water')).toMatchObject({ mode: 'live', lastTest: { ok: true, httpStatus: 200 } });
    const d = (await s.call('GET', '/api/box/devices')).body;
    expect(d.mode).toBe('demo');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // devices never called with only an API key
    expect(existsSync(join(s.dataDir, 'box-samples.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(s.dataDir, 'box-samples.json'), 'utf8'))[0]).toMatchObject({ route: 'water', status: 200 });
  });
  it('a failing live call falls back to demo, says why, and never reports Live', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"detail":"no"}', { status: 401 }));
    const s = await start({ env: { BOX_API_KEY: 'bad' }, fetchImpl: fetchImpl as any });
    const w = (await s.call('GET', '/api/box/weather')).body;
    expect(w).toMatchObject({ mode: 'demo', liveError: 'http_401' });
    expect((await s.call('GET', '/api/box/status')).body.routes.find((r: any) => r.id === 'water')).toMatchObject({ mode: 'demo', lastTest: { ok: false, httpStatus: 401 } });
  });
  it('devices with a Bearer token call /v1/devices with Authorization: Bearer', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ id: 'd1', type: 'water', latest: { do: 6.1, temp_c: 27.2, ph: 7.4, timestamp: '2026-09-29T05:00:00Z' } }]), { status: 200 }));
    const s = await start({ env: { BOX_BEARER_TOKEN: 'tok' }, fetchImpl: fetchImpl as any });
    const d = (await s.call('GET', '/api/box/devices')).body;
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.kijanispace.eu/v1/devices');
    expect((init.headers as any).Authorization).toBe('Bearer tok');
    expect(d).toMatchObject({ mode: 'live', assumedShape: true });
    expect(d.mapped.readings).toHaveLength(3);
  });
});

describe('demo reset and unknown routes', () => {
  it('keeps the saved number, clears records', async () => {
    const s = await start();
    await s.call('PUT', '/api/settings', { phone: '0712345678' });
    await s.call('POST', '/api/sync', { farmId: 'farm-demo', records: await buildChain([draft(0)]) });
    await s.call('POST', '/api/demo/reset');
    expect((await s.call('GET', '/api/checkpoints')).body.latest).toBeNull();
    expect((await s.call('GET', '/api/settings')).body.hasPhone).toBe(true);
  });
  it('unknown api route is a JSON 404', async () => {
    const s = await start();
    expect((await s.call('GET', '/api/nope')).status).toBe(404);
  });
});

describe('GET /api/sms/health', () => {
  it('with no credentials it reports dry run honestly and calls nothing', async () => {
    const fetchImpl = vi.fn();
    const s = await start({ fetchImpl: fetchImpl as any });
    const r = await s.call('GET', '/api/sms/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: false, mode: 'dry-run', live: false, reachable: null, balance: null, error: 'not_configured', senderIdIssue: 'missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('with credentials it reports reachable and the balance, and never the secrets', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { credit_balance: 250 } }), { status: 200 }));
    const s = await start({ env: { BEEM_API_KEY: 'k-test', BEEM_SECRET_KEY: 's-test', BEEM_SENDER_ID: 'KIPIMO' }, fetchImpl: fetchImpl as any });
    const r = await s.call('GET', '/api/sms/health');
    expect(r.body).toMatchObject({ configured: true, mode: 'configured', reachable: true, balance: 250, live: true, senderIdSet: true, senderIdIssue: null });
    expect((fetchImpl.mock.calls[0] as any)[0]).toBe('https://apisms.beem.africa/public/v1/vendors/balance');
    expect(JSON.stringify(r.body)).not.toMatch(/k-test|s-test|KIPIMO/);
  });
  it('tells rejected credentials apart from an unreachable Beem', async () => {
    const rejected = await start({ env: { BEEM_API_KEY: 'k', BEEM_SECRET_KEY: 's', BEEM_SENDER_ID: 'S' }, fetchImpl: (async () => new Response(JSON.stringify({ code: 120 }), { status: 401 })) as any });
    expect((await rejected.call('GET', '/api/sms/health')).body).toMatchObject({ configured: true, reachable: true, balance: null, live: false, error: 'invalid_credentials', httpStatus: 401 });
    const down = await start({ env: { BEEM_API_KEY: 'k', BEEM_SECRET_KEY: 's', BEEM_SENDER_ID: 'S' }, fetchImpl: (async () => { throw new Error('boom'); }) as any });
    expect((await down.call('GET', '/api/sms/health')).body).toMatchObject({ configured: true, reachable: false, balance: null, live: false, error: 'network_error' });
  });
  it('flags a sender ID Beem would reject, without echoing it', async () => {
    const s = await start({ env: { BEEM_API_KEY: 'k', BEEM_SECRET_KEY: 's', BEEM_SENDER_ID: 'WAY-TOO-LONG-SENDER' }, fetchImpl: (async () => new Response(JSON.stringify({ data: { credit_balance: 1 } }))) as any });
    const r = await s.call('GET', '/api/sms/health');
    expect(r.body).toMatchObject({ senderIdSet: true, senderIdIssue: 'too_long' });
    expect(JSON.stringify(r.body)).not.toContain('WAY-TOO-LONG-SENDER');
  });
});

describe('delivery reports', () => {
  const env = { BEEM_API_KEY: 'k', BEEM_SECRET_KEY: 's', BEEM_SENDER_ID: 'SENDER' };
  /** Send one live (mocked) SMS so there is something for a report to attach to. */
  const sent = async (over: Partial<AppOptions> = {}) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ successful: true, request_id: 77, code: 100 }), { status: 200 }));
    const s = await start({ env, fetchImpl: fetchImpl as any, ...over });
    await s.call('PUT', '/api/settings', { phone: '0712345678' });
    await s.call('POST', '/api/sms/send', { kind: 'alert', lang: 'sw', template: 'do_critical', params: { cage: 3, value: 3.8 }, requestId: 'a1', alertId: 'alert-1' });
    return s;
  };
  const form = async (base: string, body: Record<string, string>, path = '/api/sms/dlr') => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  it('a callback marks the matching message Delivered', async () => {
    const s = await sent();
    expect((await form(s.base, { DLRID: '77', STATUS: '1', DESTADDR: '255712345678' })).body).toEqual({ ok: true, matched: true });
    const log = (await s.call('GET', '/api/sms/log')).body.log;
    expect(log.find((e: any) => e.id === 'a1').delivery).toMatchObject({ state: 'delivered', raw: '1 Delivered', via: 'callback' });
  });
  it('a failure code is shown as failed, and delivery is separate from "sent"', async () => {
    const s = await sent();
    await form(s.base, { DLRID: '77', STATUS: '3' });
    const e = (await s.call('GET', '/api/sms/log')).body.log.find((x: any) => x.id === 'a1');
    expect(e.state).toBe('sent'); // Beem accepted it
    expect(e.delivery.state).toBe('failed'); // but it never reached the handset
  });
  it('an unmatched report is kept, acknowledged with 200, and never attached to another message', async () => {
    const s = await sent();
    expect((await form(s.base, { DLRID: 'nobody', STATUS: '1' })).body).toEqual({ ok: true, matched: false });
    expect((await s.call('GET', '/api/sms/log')).body.log.find((e: any) => e.id === 'a1').delivery).toBeUndefined();
    expect(await s.store.listUnmatchedDlr()).toMatchObject([{ dlrId: 'nobody', raw: '1 Delivered' }]);
  });
  it('a body that is not a delivery report is refused, not guessed at', async () => {
    const s = await sent();
    expect((await form(s.base, { SOURCEADDR: '255712345678', MESSAGE: 'hello' })).status).toBe(400);
  });
  it('BEEM_DLR_TOKEN guards the endpoint when it is set', async () => {
    const s = await sent({ env: { ...env, BEEM_DLR_TOKEN: 'shhh' } });
    expect((await form(s.base, { DLRID: '77', STATUS: '1' })).status).toBe(403);
    expect((await form(s.base, { DLRID: '77', STATUS: '1' }, '/api/sms/dlr?token=shhh')).status).toBe(200);
  });
  it('polling leaves messages younger than Beem\'s 5 minutes alone', async () => {
    const s = await sent();
    const r = await s.call('POST', '/api/sms/dlr/poll');
    expect(r.body).toMatchObject({ pending: 1, checked: 0, updated: 0, tooRecent: 1, minDelayMinutes: 5 });
  });
  it('polling after 5 minutes asks Beem and records what it says', async () => {
    const fetchImpl = vi.fn(async (url: any) => String(url).includes('dlrapi')
      ? new Response(JSON.stringify([{ dest_addr: '255712345678', status: 'DELIVERED', request_id: '77' }]))
      : new Response(JSON.stringify({ successful: true, request_id: 77, code: 100 })));
    const s = await sent({ fetchImpl: fetchImpl as any });
    s.clock.t += 6 * 60_000;
    expect((await s.call('POST', '/api/sms/dlr/poll')).body).toMatchObject({ checked: 1, updated: 1, tooRecent: 0 });
    const e = (await s.call('GET', '/api/sms/log')).body.log.find((x: any) => x.id === 'a1');
    expect(e.delivery).toMatchObject({ state: 'delivered', raw: 'DELIVERED', via: 'poll' });
  });
  it('polling without credentials calls nothing', async () => {
    const fetchImpl = vi.fn();
    const s = await start({ fetchImpl: fetchImpl as any });
    expect((await s.call('POST', '/api/sms/dlr/poll')).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('a dry-run message is never asked about: nothing was ever sent', async () => {
    const s = await start();
    await s.call('PUT', '/api/settings', { phone: '0712345678' });
    await s.call('POST', '/api/sms/send', { kind: 'test', lang: 'sw', requestId: 'd1' });
    const e = (await s.call('GET', '/api/sms/log')).body.log.find((x: any) => x.id === 'd1');
    expect(e.state).toBe('dry_run');
    expect(e.beemRequestId).toBeUndefined();
    expect(e.delivery).toBeUndefined();
  });
});
