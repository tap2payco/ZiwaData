import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppOptions } from '../server/app';
import { buildChain } from '../src/core/hashchain';
import { isGsm7, smsLength, SMS_MAX } from '../src/core/sms-templates';
import type { ReadingDraft } from '../src/core/types';
import {
  AUTH_LIMITS, authRequired, codeMessage, generateCode, generateToken, hashCode, hashesEqual,
  looksLikeCode, readCookie, roleForPhone, sessionCookie, clearedCookie,
} from '../server/auth/auth';

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  closers.splice(0).forEach((c) => c());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

const AUTH_ENV = { AUTH_REQUIRED: '1', AUTH_SECRET: 'test-secret-not-a-real-one' };
const PHONE = '0712345678';
const NORMALISED = '255712345678';

async function start(over: Partial<AppOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'auth-'));
  dirs.push(dataDir);
  const clock = { t: Date.parse('2026-09-29T06:10:00Z') };
  const built = createApp({ dataDir, env: {}, now: () => clock.t, sleep: async () => {}, ...over });
  const server = built.app.listen(0);
  closers.push(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** Keeps whatever cookie the server last set, like a browser would. */
  let cookie: string | null = null;
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0]!;
    return { status: res.status, body: (await res.json().catch(() => null)) as any, setCookie };
  };
  return { ...built, call, clock, base, cookies: () => cookie, forget: () => { cookie = null; } };
}

/**
 * Get the code the way it actually leaves the server.
 * In dry run (no Beem credentials) it is printed to the server console and never sent over HTTP.
 * With credentials it only exists inside the message handed to Beem, so `beem` reads it from there.
 */
async function requestCode(s: Awaited<ReturnType<typeof start>>, phone = PHONE, beem?: { mock: { calls: unknown[][] } }) {
  const before = beem?.mock.calls.length ?? 0;
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const res = await s.call('POST', '/api/auth/request-code', { phone });
  const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[auth]')) ?? '';
  spy.mockRestore();
  let source = line;
  if (beem) {
    const call = beem.mock.calls[before] as [string, { body?: string }] | undefined;
    source = call?.[1]?.body ?? '';
  }
  const code = (source.match(/\b(\d{6})\b/) ?? [])[1] ?? null;
  return { res, code };
}

const draft = (i: number): ReadingDraft => ({
  cageId: 'farm-demo-c1', farmId: 'farm-demo', kind: 'do', value: 5 + i / 10, unit: 'mg/L',
  ts: new Date(Date.UTC(2026, 8, 1, i)).toISOString(), source: 'manual', via: 'app', demo: true,
});

// -------------------------------------------------------------------------------------------------
describe('auth building blocks', () => {
  it('makes a 6-digit code from a cryptographic source, keeping leading zeros', () => {
    const codes = Array.from({ length: 200 }, () => generateCode());
    for (const c of codes) expect(c).toMatch(/^\d{6}$/);
    expect(new Set(codes).size).toBeGreaterThan(150); // not a counter, not a constant
  });
  it('makes a long random session token', () => {
    const t = generateToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(generateToken()).not.toBe(t);
  });
  it('hashes a code with the secret, the phone and the code, so no two differ only by chance', () => {
    const h = hashCode('s', NORMALISED, '123456');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('123456');                       // the code is not recoverable from the hash
    expect(hashCode('other', NORMALISED, '123456')).not.toBe(h);   // a different secret
    expect(hashCode('s', '255700000000', '123456')).not.toBe(h);   // a different number
    expect(hashCode('s', NORMALISED, '123457')).not.toBe(h);       // a different code
  });
  it('compares hashes safely and rejects rubbish', () => {
    const a = hashCode('s', NORMALISED, '123456');
    expect(hashesEqual(a, a)).toBe(true);
    expect(hashesEqual(a, hashCode('s', NORMALISED, '999999'))).toBe(false);
    expect(hashesEqual(a, '')).toBe(false);
    expect(hashesEqual('', '')).toBe(false);
    expect(hashesEqual(a, a.slice(0, 40))).toBe(false);
  });
  it.each(['123456', '000000', '004321'])('%s is a well-formed code', (c) => expect(looksLikeCode(c)).toBe(true));
  it.each(['12345', '1234567', '12 34 56', '+123456', 'abcdef', '', null, 123456])('%j is not', (c) => expect(looksLikeCode(c)).toBe(false));

  it('reads roles from AUTH_ROLES and defaults everyone else to farmer', () => {
    const env = { AUTH_ROLES: `${NORMALISED}:lender, 255713000000:extension, 255714000000:nonsense` };
    expect(roleForPhone(env, NORMALISED)).toBe('lender');
    expect(roleForPhone(env, '255713000000')).toBe('extension');
    expect(roleForPhone(env, '255714000000')).toBe('farmer'); // an unknown role name is ignored, not trusted
    expect(roleForPhone(env, '255799999999')).toBe('farmer');
    expect(roleForPhone({}, NORMALISED)).toBe('farmer');
  });
  it('only treats an explicit switch as sign-in required', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'ON']) expect(authRequired({ AUTH_REQUIRED: v })).toBe(true);
    for (const v of ['', '0', 'false', 'no', undefined]) expect(authRequired({ AUTH_REQUIRED: v })).toBe(false);
  });

  it('sends the code in one GSM-7 SMS, in both languages', () => {
    for (const lang of ['sw', 'en'] as const) {
      const m = codeMessage('123456', lang, 'Kipimo');
      expect(m).toContain('123456');
      expect(isGsm7(m)).toBe(true);
      expect(smsLength(m)).toBeLessThanOrEqual(SMS_MAX);
    }
  });

  it('builds a cookie a script cannot read and another site cannot use', () => {
    const c = sessionCookie('tok', { secure: true, maxAgeMs: 60_000 });
    expect(c).toContain('sid=tok');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Secure');
    expect(c).toContain('Max-Age=60');
    expect(sessionCookie('tok', { secure: false, maxAgeMs: 60_000 })).not.toContain('Secure');
    expect(clearedCookie(false)).toContain('Max-Age=0');
  });
  it('reads its own cookie out of a header and ignores the rest', () => {
    expect(readCookie('a=1; sid=abc; b=2')).toBe('abc');
    expect(readCookie('sid=abc')).toBe('abc');
    expect(readCookie('other=1')).toBeNull();
    expect(readCookie(undefined)).toBeNull();
    expect(readCookie('')).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------------
describe('with sign-in off, the demo is unchanged', () => {
  it('leaves every route open and says so', async () => {
    const s = await start();
    expect((await s.call('GET', '/api/auth/me')).body).toEqual({ authRequired: false, user: null, signedIn: false });
    expect((await s.call('GET', '/api/settings')).status).toBe(200);
    expect((await s.call('POST', '/api/sync', { farmId: 'farm-demo', records: await buildChain([draft(0)]) })).status).toBe(200);
  });
});

// -------------------------------------------------------------------------------------------------
describe('with sign-in required', () => {
  it('refuses the protected routes and still allows health and sign-in', async () => {
    const s = await start({ env: AUTH_ENV });
    for (const [method, path] of [['GET', '/api/settings'], ['GET', '/api/sms/log'], ['GET', '/api/inbox'], ['GET', '/api/checkpoints'], ['GET', '/api/box/status'], ['POST', '/api/demo/reset']] as const) {
      const r = await s.call(method, path);
      expect({ path, status: r.status }).toEqual({ path, status: 401 });
      expect(r.body).toEqual({ error: 'sign_in_required' });
    }
    expect((await s.call('GET', '/api/health')).status).toBe(200);
    expect((await s.call('GET', '/api/auth/me')).body).toMatchObject({ authRequired: true, signedIn: false, user: null });
  });

  it('signs in with a code and keeps the session', async () => {
    const s = await start({ env: AUTH_ENV });
    const { res, code } = await requestCode(s);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, dryRun: true });
    // The code must never travel over HTTP.
    expect(JSON.stringify(res.body)).not.toContain(code!);
    expect(code).toMatch(/^\d{6}$/);

    const v = await s.call('POST', '/api/auth/verify', { phone: PHONE, code });
    expect(v.status).toBe(200);
    expect(v.setCookie).toContain('HttpOnly');
    expect(v.setCookie).toContain('SameSite=Lax');
    expect(v.body.user).toMatchObject({ role: 'farmer', phoneMasked: '+255 7•• ••• 678' });
    // The full number is never returned, even to its owner.
    expect(JSON.stringify(v.body)).not.toContain(NORMALISED);

    expect((await s.call('GET', '/api/auth/me')).body).toMatchObject({ signedIn: true, user: { role: 'farmer' } });
    expect((await s.call('GET', '/api/settings')).status).toBe(200);
  });

  it('never says whether a number is already known', async () => {
    const s = await start({ env: AUTH_ENV });
    const first = await requestCode(s);
    s.clock.t += AUTH_LIMITS.resendGapMs + 1000;
    const second = await requestCode(s, '0713000000');
    expect(first.res.body).toEqual(second.res.body);
  });

  it('refuses a wrong code and counts the attempt', async () => {
    const s = await start({ env: AUTH_ENV });
    const { code } = await requestCode(s);
    const wrong = code === '000000' ? '111111' : '000000';
    const r = await s.call('POST', '/api/auth/verify', { phone: PHONE, code: wrong });
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: 'bad_code', attemptsLeft: AUTH_LIMITS.maxAttempts - 1 });
    expect(r.setCookie).toBeNull();
    // The real code still works afterwards.
    expect((await s.call('POST', '/api/auth/verify', { phone: PHONE, code })).status).toBe(200);
  });

  it('kills the code after too many wrong guesses', async () => {
    const s = await start({ env: AUTH_ENV });
    const { code } = await requestCode(s);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < AUTH_LIMITS.maxAttempts; i++) {
      expect((await s.call('POST', '/api/auth/verify', { phone: PHONE, code: wrong })).status).toBe(401);
    }
    // Even the correct code is now useless: a new one must be requested.
    expect((await s.call('POST', '/api/auth/verify', { phone: PHONE, code })).status).toBe(401);
  });

  it('uses a code once only', async () => {
    const s = await start({ env: AUTH_ENV });
    const { code } = await requestCode(s);
    expect((await s.call('POST', '/api/auth/verify', { phone: PHONE, code })).status).toBe(200);
    s.forget();
    expect((await s.call('POST', '/api/auth/verify', { phone: PHONE, code })).status).toBe(401);
  });

  it('expires a code', async () => {
    const s = await start({ env: AUTH_ENV });
    const { code } = await requestCode(s);
    s.clock.t += AUTH_LIMITS.codeTtlMs + 1000;
    expect((await s.call('POST', '/api/auth/verify', { phone: PHONE, code })).status).toBe(401);
  });

  it('will not send a second code straight away', async () => {
    const s = await start({ env: AUTH_ENV });
    await requestCode(s);
    const again = await s.call('POST', '/api/auth/request-code', { phone: PHONE });
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ error: 'too_soon' });
    expect(again.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('stops after the hourly limit for one number', async () => {
    const s = await start({ env: AUTH_ENV });
    for (let i = 0; i < AUTH_LIMITS.maxCodesPerHour; i++) {
      expect((await s.call('POST', '/api/auth/request-code', { phone: PHONE })).status).toBe(200);
      s.clock.t += AUTH_LIMITS.resendGapMs + 1000;
    }
    const r = await s.call('POST', '/api/auth/request-code', { phone: PHONE });
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: 'too_many_codes' });
  });

  it('rejects a number that is not Tanzanian and a malformed code', async () => {
    const s = await start({ env: AUTH_ENV });
    expect((await s.call('POST', '/api/auth/request-code', { phone: '+254712345678' })).status).toBe(400);
    expect((await s.call('POST', '/api/auth/request-code', { phone: 'abc' })).status).toBe(400);
    expect((await s.call('POST', '/api/auth/verify', { phone: PHONE, code: '12345' })).status).toBe(400);
    expect((await s.call('POST', '/api/auth/verify', { phone: PHONE, code: 123456 })).status).toBe(400);
  });

  it('logs the code SMS without the number or the code', async () => {
    const s = await start({ env: AUTH_ENV });
    const { code } = await requestCode(s);
    await s.call('POST', '/api/auth/verify', { phone: PHONE, code });
    const log = (await s.call('GET', '/api/sms/log')).body.log;
    expect(log[0]).toMatchObject({ kind: 'auth', state: 'dry_run' });
    const text = JSON.stringify(log);
    expect(text).not.toContain(NORMALISED);
    expect(text).not.toContain('712345678');
    expect(text).not.toContain(code!);
  });

  it('signs out', async () => {
    const s = await start({ env: AUTH_ENV });
    const { code } = await requestCode(s);
    await s.call('POST', '/api/auth/verify', { phone: PHONE, code });
    expect((await s.call('POST', '/api/auth/logout')).status).toBe(200);
    expect((await s.call('GET', '/api/auth/me')).body).toMatchObject({ signedIn: false });
    expect((await s.call('GET', '/api/settings')).status).toBe(401);
  });

  it('refuses a made-up or tampered cookie', async () => {
    const s = await start({ env: AUTH_ENV });
    const res = await fetch(`${s.base}/api/settings`, { headers: { Cookie: 'sid=' + 'a'.repeat(64) } });
    expect(res.status).toBe(401);
  });
});

// -------------------------------------------------------------------------------------------------
describe('roles the server enforces', () => {
  const lenderEnv = { ...AUTH_ENV, AUTH_ROLES: `${NORMALISED}:lender` };

  const signIn = async (s: Awaited<ReturnType<typeof start>>, phone = PHONE) => {
    const { code } = await requestCode(s, phone);
    return s.call('POST', '/api/auth/verify', { phone, code });
  };

  it('gives the role from AUTH_ROLES at first sign-in', async () => {
    const s = await start({ env: lenderEnv });
    expect((await signIn(s)).body.user.role).toBe('lender');
  });

  it('will not let a lender write to the record chain', async () => {
    const s = await start({ env: lenderEnv });
    await signIn(s);
    const r = await s.call('POST', '/api/sync', { farmId: 'farm-demo', records: await buildChain([draft(0)]) });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: 'wrong_role' });
    // Nothing was written.
    expect(await s.store.getRecords('farm-demo')).toEqual([]);
  });

  it('lets a lender read the checkpoints it needs', async () => {
    const s = await start({ env: lenderEnv });
    await signIn(s);
    expect((await s.call('GET', '/api/checkpoints')).status).toBe(200);
  });

  it('lets a farmer write, and keeps SMS sending to farmers', async () => {
    const s = await start({ env: AUTH_ENV });
    await signIn(s);
    expect((await s.call('POST', '/api/sync', { farmId: 'farm-demo', records: await buildChain([draft(0)]) })).status).toBe(200);
    await s.call('PUT', '/api/settings', { phone: PHONE });
    expect((await s.call('POST', '/api/sms/send', { kind: 'test', lang: 'sw', requestId: 'r1' })).status).toBe(200);
  });

  it('will not let a lender send an SMS', async () => {
    const s = await start({ env: lenderEnv });
    await signIn(s);
    expect((await s.call('POST', '/api/sms/send', { kind: 'test', lang: 'sw', requestId: 'r1' })).status).toBe(403);
  });

  it('ignores a role the browser asks for: a role is never taken from a request', async () => {
    const s = await start({ env: AUTH_ENV });
    const { code } = await requestCode(s);
    const v = await s.call('POST', '/api/auth/verify', { phone: PHONE, code, role: 'lender' });
    expect(v.body.user.role).toBe('farmer');
    // And it cannot be changed afterwards through the settings route either.
    await s.call('PUT', '/api/settings', { smsLang: 'en', role: 'lender' });
    expect((await s.call('GET', '/api/auth/me')).body.user.role).toBe('farmer');
  });

  it('keeps one signed-in farmer\'s phone number away from another', async () => {
    const s = await start({ env: AUTH_ENV });
    await signIn(s, PHONE);
    await s.call('PUT', '/api/settings', { phone: PHONE });
    expect((await s.call('GET', '/api/settings')).body).toMatchObject({ hasPhone: true });

    s.forget();
    s.clock.t += AUTH_LIMITS.resendGapMs + 1000;
    await signIn(s, '0713000000');
    // A different account starts with no number of its own.
    expect((await s.call('GET', '/api/settings')).body).toMatchObject({ hasPhone: false, phoneMasked: null });
  });
});

// -------------------------------------------------------------------------------------------------
describe('the delivery-report callback is exempt on purpose', () => {
  it('still works with sign-in on, because Beem has no session', async () => {
    const env = { ...AUTH_ENV, BEEM_API_KEY: 'k', BEEM_SECRET_KEY: 's', BEEM_SENDER_ID: 'SENDER' };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ successful: true, request_id: 77, code: 100 }), { status: 200 }));
    const s = await start({ env, fetchImpl: fetchImpl as any });
    // Credentials are set, so the code never reaches the console: read it out of the Beem request instead.
    const { code } = await requestCode(s, PHONE, fetchImpl);
    expect((await s.call('POST', '/api/auth/verify', { phone: PHONE, code })).status).toBe(200);
    await s.call('PUT', '/api/settings', { phone: PHONE });
    await s.call('POST', '/api/sms/send', { kind: 'alert', lang: 'sw', template: 'do_critical', params: { cage: 3, value: 3.8 }, requestId: 'a1', alertId: 'alert-1' });

    // No cookie at all, exactly like a request from Beem.
    const res = await fetch(`${s.base}/api/sms/dlr`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ DLRID: '77', STATUS: '1' }).toString(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, matched: true });
  });
});
