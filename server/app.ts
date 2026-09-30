import express, { type NextFunction, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { DEMO_POINT } from '../src/core/config';
import { verifyChain } from '../src/core/hashchain';
import { maskPhone, normalizeTzPhone } from '../src/core/phone';
import { demoFarms, DEMO_FARM_ID } from '../src/core/seed';
import { parseInboundSms } from '../src/core/sms-parser';
import { isGsm7, renderSms, smsLength, SMS_MAX, ALL_TEMPLATE_IDS, type SmsParams, type SmsTemplateId } from '../src/core/sms-templates';
import type { Checkpoint, Kind, Lang, Reading, ReadingDraft, SmsState } from '../src/core/types';
import { BoxAdapter, boxConfigFromEnv, boxPointValid } from './box/adapter';
import {
  beemConfigured, checkBalance, getDeliveryReport, parseDlrCallback, sendSMSWithRetry, senderIdIssue,
  DLR_MIN_POLL_DELAY_MS, type BeemEnv,
} from './sms/beem';
import { JsonStore } from './store/json';
import type { AppStore, SmsLogEntry, User } from './store/types';
import {
  AUTH_LIMITS, authRequired, authSecret, clearedCookie, codeMessage, generateCode, generateToken,
  hashCode, hashPin, hashesEqual, hashToken, isRole, looksLikeCode, readCookie, roleForPhone, sessionCookie,
  type Role,
} from './auth/auth';
import { BRAND } from '../src/brand';

export interface AppOptions {
  dataDir: string;
  /** Storage backend. Defaults to the JSON file store. Pass a PgStore, or a fake, to swap it out. */
  store?: AppStore;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Test hook: no real waiting between SMS retries. */
  sleep?: (ms: number) => Promise<void>;
}

const KINDS: Kind[] = ['do', 'temp', 'ph', 'temp_deep', 'feed', 'mortality', 'incident'];
const HEX64 = /^[0-9a-f]{64}$/;
const shortId = () => randomBytes(6).toString('hex');

/** Shape check for a synced record. Rejects anything malformed instead of storing it. */
export function validateReading(r: any): r is Reading {
  return (
    r && typeof r === 'object' &&
    typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 120 &&
    Number.isInteger(r.seq) && r.seq >= 1 &&
    typeof r.cageId === 'string' && r.cageId.length <= 120 && typeof r.farmId === 'string' && r.farmId.length <= 120 &&
    KINDS.includes(r.kind) && (typeof r.value === 'number' ? Number.isFinite(r.value) : typeof r.value === 'string' && r.value.length <= 200) &&
    typeof r.unit === 'string' && typeof r.ts === 'string' && Number.isFinite(Date.parse(r.ts)) &&
    ['manual', 'sensor', 'satellite'].includes(r.source) && (r.via === undefined || ['app', 'sms', 'attestation'].includes(r.via)) &&
    typeof r.demo === 'boolean' && typeof r.hash === 'string' && HEX64.test(r.hash) && typeof r.prevHash === 'string' && HEX64.test(r.prevHash) &&
    (r.note === undefined || (typeof r.note === 'string' && r.note.length <= 500))
  );
}

export function createApp(opts: AppOptions) {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const store: AppStore = opts.store ?? new JsonStore(opts.dataDir);
  const box = new BoxAdapter(boxConfigFromEnv(env), { fetchImpl: opts.fetchImpl, dataDir: opts.dataDir, now });
  const beemEnv: BeemEnv = { BEEM_API_KEY: env.BEEM_API_KEY, BEEM_SECRET_KEY: env.BEEM_SECRET_KEY, BEEM_API_SECRET: env.BEEM_API_SECRET, BEEM_SENDER_ID: env.BEEM_SENDER_ID };
  const maxSmsPerHour = Math.max(0, Number(env.SMS_MAX_PER_HOUR ?? 5) || 5);
  // "Live" is only ever reported after a real success in THIS server session.
  const beemSession = { lastOkAt: null as string | null, lastAttempt: null as { at: string; state: SmsState } | null };
  const demoCageCount = demoFarms().find((f) => f.id === DEMO_FARM_ID)!.cages.length;

  // ---------------- Auth ----------------
  const { secret: AUTH_SECRET, ephemeral: authSecretEphemeral } = authSecret(env);
  const authOn = authRequired(env);
  /** A global ceiling on code SMS per hour, so nobody can run up an SMS bill through the sign-in form. */
  const maxAuthCodesPerHourGlobal = Math.max(1, Number(env.AUTH_MAX_CODES_PER_HOUR ?? 50) || 50);
  /**
   * Whoever is making this request, when a valid session cookie is present. Kept off the Request object
   * itself so nothing can be smuggled in through the request body.
   */
  const userOf = new WeakMap<Request, User>();
  const currentUser = (req: Request) => userOf.get(req) ?? null;
  /** Cookies get Secure unless we are on plain-HTTP localhost, where a browser would then drop them. */
  const cookieSecure = (req: Request) => req.secure || (req.headers['x-forwarded-proto'] === 'https');

  const app = express();
  app.disable('x-powered-by');

  /**
   * Express 4 does NOT forward a rejected promise out of an async handler: the request just hangs until the
   * client gives up. Now that storage is async, every route is one dropped database connection away from that.
   * This wraps route handlers so a rejection reaches the error handler at the bottom and becomes a clean 500.
   * Only (req, res) handlers are wrapped; middleware taking (req, res, next) is left alone.
   * Express 5 does this itself: delete this block when we upgrade.
   */
  const wrapAsync = (h: unknown): unknown =>
    typeof h === 'function' && h.length <= 2
      ? (req: Request, res: Response, next: NextFunction) => Promise.resolve((h as (a: Request, b: Response) => unknown)(req, res)).catch(next)
      : h;
  for (const method of ['get', 'post', 'put'] as const) {
    const original = app[method].bind(app);
    (app as unknown as Record<string, unknown>)[method] = (path: string, ...handlers: unknown[]) =>
      original(path, ...(handlers.map(wrapAsync) as never[]));
  }

  app.use(express.json({ limit: '5mb' }));
  // Beem's delivery-report callback is documented as application/x-www-form-urlencoded.
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  // CORS: allow same-origin, LAN origins, or configured origins
  const allowed = new Set((env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    if (origin) {
      const isLocalhost = /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(origin);
      if (allowed.size === 0 || allowed.has('*') || allowed.has(origin) || isLocalhost || env.NODE_ENV !== 'production') {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        if (req.method === 'OPTIONS') return void res.sendStatus(204);
      }
    }
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date(now()).toISOString() }));

  app.get('/api/network-info', (_req, res) => {
    try {
      const interfaces = os.networkInterfaces();
      const ips: string[] = [];
      for (const name in interfaces) {
        const net = interfaces[name];
        if (!net) continue;
        for (const iface of net) {
          if (iface.family === 'IPv4' && !iface.internal) {
            ips.push(iface.address);
          }
        }
      }
      res.json({ ok: true, ips, primaryIp: ips[0] || null, port: 5173 });
    } catch {
      res.json({ ok: true, ips: [], primaryIp: null, port: 5173 });
    }
  });

  /**
   * Read the session cookie on every request and attach the user. This NEVER rejects: it only
   * establishes who you are. Whether a route needs a user is decided by the guards below.
   */
  app.use(async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = readCookie(req.headers.cookie);
      if (token) {
        const nowIso = new Date(now()).toISOString();
        const found = await store.findSession(hashToken(AUTH_SECRET, token), nowIso);
        if (found) {
          userOf.set(req, found.user);
          // Write back last-seen at most once an hour, so reading a page is not a database write.
          if (now() - Date.parse(found.session.lastSeenAt) > AUTH_LIMITS.touchEveryMs) {
            await store.touchSession(found.session.tokenHash, nowIso);
            await store.touchUser(found.user.id, nowIso);
          }
        }
      }
    } catch { /* a broken session must not take the whole request down */ }
    next();
  });

  /**
   * Require a signed-in user, and optionally one of a set of roles.
   * With AUTH_REQUIRED off the app stays the open demo it has always been, and these do nothing.
   * The role is read from the user row the server loaded, never from anything the browser sent.
   */
  const requireAuth = (...roles: Role[]) => (req: Request, res: Response, next: NextFunction) => {
    if (!authOn) return void next();
    const user = currentUser(req);
    if (!user) return void res.status(401).json({ error: 'sign_in_required' });
    if (roles.length && !roles.includes(user.role)) return void res.status(403).json({ error: 'wrong_role', needs: roles });
    next();
  };

  // ---------------- Sign-in: phone number plus a one-time code by SMS ----------------
  const publicUser = (u: User) => ({
    id: u.id,
    name: u.name ?? null,
    phoneMasked: maskPhone(u.phone),   // never the full number
    role: u.role,
    hasPin: !!u.pinHash,
    consentAt: u.consentAt ?? null,
  });

  app.get('/api/auth/me', (req, res) => {
    const u = currentUser(req);
    res.json({
      authRequired: authOn,
      user: u ? publicUser(u) : null,
      // The UI shows "Demo: no sign-in" only while this is false.
      signedIn: !!u,
    });
  });

  /**
   * Ask for a one-time code. Answers the SAME way whether or not the number is known, so this endpoint
   * cannot be used to find out who has an account.
   * Rate limits: one code per minute per number, AUTH_LIMITS.maxCodesPerHour per number, and a global
   * hourly ceiling so the sign-in form can never be turned into an SMS bill.
   * The number and the code are never logged.
   */
  app.post('/api/auth/request-code', async (req, res) => {
    const phone = typeof req.body?.phone === 'string' ? normalizeTzPhone(req.body.phone) : null;
    if (!phone) return void res.status(400).json({ error: 'bad_phone' });
    const lang: Lang = req.body?.lang === 'en' ? 'en' : 'sw';
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();

    const last = await store.lastCodeAt(phone);
    if (last && nowMs - Date.parse(last) < AUTH_LIMITS.resendGapMs) {
      const retryAfter = Math.ceil((AUTH_LIMITS.resendGapMs - (nowMs - Date.parse(last))) / 1000);
      return void res.status(429).json({ error: 'too_soon', retryAfterSeconds: retryAfter });
    }
    const hourAgo = new Date(nowMs - 3600_000).toISOString();
    if (await store.countCodesSince(phone, hourAgo) >= AUTH_LIMITS.maxCodesPerHour) {
      return void res.status(429).json({ error: 'too_many_codes' });
    }
    // Only sign-in codes count here: this ceiling protects the SMS bill, not the farmer's alerts.
    if (await store.countSmsSince(hourAgo, ['sent', 'failed'], ['auth']) >= maxAuthCodesPerHourGlobal) {
      return void res.status(429).json({ error: 'service_busy' });
    }

    const code = generateCode();
    await store.putCode({
      id: '', phone, codeHash: hashCode(AUTH_SECRET, phone, code),
      createdAt: nowIso, expiresAt: new Date(nowMs + AUTH_LIMITS.codeTtlMs).toISOString(), attempts: 0,
    });

    const message = codeMessage(code, lang, BRAND.name);
    const sent = await sendSMSWithRetry({ to: phone, message }, { env: beemEnv, fetchImpl: opts.fetchImpl, sleep: opts.sleep });
    const state: SmsState = sent.dryRun ? 'dry_run' : sent.success ? 'sent' : 'failed';
    await logSms({ id: `auth-${shortId()}`, kind: 'auth', state, lang, chars: smsLength(message), error: sent.success || sent.dryRun ? undefined : sent.error });
    if (sent.success) beemSession.lastOkAt = nowIso;

    if (sent.dryRun) {
      // No Beem credentials, so the code cannot reach a phone. Print it to the SERVER console only, never
      // in the response, so a local demo still works and nothing leaks over HTTP. Impossible once live.
      console.log(`[auth] dry run: one-time code for a sign-in request is ${code} (no Beem credentials; this is never shown over HTTP)`);
    }
    // Always the same answer: never reveal whether the number is known or whether the SMS worked.
    res.json({ ok: true, dryRun: !!sent.dryRun, expiresInSeconds: AUTH_LIMITS.codeTtlMs / 1000 });
  });

  /**
   * Register a new account with phone number, role, optional name and PIN.
   */
  app.post('/api/auth/register', async (req, res) => {
    const phone = typeof req.body?.phone === 'string' ? normalizeTzPhone(req.body.phone) : null;
    if (!phone) return void res.status(400).json({ error: 'bad_phone' });

    const existing = await store.findUserByPhone(phone);
    if (existing) {
      return void res.status(409).json({ error: 'user_exists', message: 'Account already exists. Please sign in.' });
    }

    const requestedRole: Role = isRole(req.body?.role) ? req.body.role : roleForPhone(env, phone);
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : undefined;
    const pin = typeof req.body?.pin === 'string' && req.body.pin.length >= 4 ? req.body.pin : undefined;
    const pinHash = pin ? hashPin(AUTH_SECRET, pin) : undefined;
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();

    const user = await store.createUser({
      id: `u-${shortId()}`,
      phone,
      name,
      role: requestedRole,
      pinHash,
      createdAt: nowIso,
      disabled: false,
    });

    const code = generateCode();
    await store.putCode({
      id: '', phone, codeHash: hashCode(AUTH_SECRET, phone, code),
      createdAt: nowIso, expiresAt: new Date(nowMs + AUTH_LIMITS.codeTtlMs).toISOString(), attempts: 0,
    });

    const lang: Lang = req.body?.lang === 'en' ? 'en' : 'sw';
    const message = codeMessage(code, lang, BRAND.name);
    const sent = await sendSMSWithRetry({ to: phone, message }, { env: beemEnv, fetchImpl: opts.fetchImpl, sleep: opts.sleep });
    const state: SmsState = sent.dryRun ? 'dry_run' : sent.success ? 'sent' : 'failed';
    await logSms({ id: `auth-${shortId()}`, kind: 'auth', state, lang, chars: smsLength(message), error: sent.success || sent.dryRun ? undefined : sent.error });

    if (sent.dryRun) {
      console.log(`[auth] dry run registration code for ${phone} is ${code}`);
    }

    res.json({ ok: true, dryRun: !!sent.dryRun, expiresInSeconds: AUTH_LIMITS.codeTtlMs / 1000, user: publicUser(user) });
  });

  /**
   * Direct Sign In with Phone + PIN.
   */
  app.post('/api/auth/login-pass', async (req, res) => {
    const phone = typeof req.body?.phone === 'string' ? normalizeTzPhone(req.body.phone) : null;
    const pin = typeof req.body?.pin === 'string' ? req.body.pin : null;
    if (!phone || !pin) return void res.status(400).json({ error: 'bad_request' });

    const user = await store.findUserByPhone(phone);
    if (!user || !user.pinHash) return void res.status(401).json({ error: 'invalid_credentials' });
    if (user.disabled) return void res.status(403).json({ error: 'account_disabled' });

    if (!hashesEqual(user.pinHash, hashPin(AUTH_SECRET, pin))) {
      return void res.status(401).json({ error: 'invalid_credentials' });
    }

    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();
    const token = generateToken();
    await store.createSession({
      tokenHash: hashToken(AUTH_SECRET, token), userId: user.id,
      createdAt: nowIso, expiresAt: new Date(nowMs + AUTH_LIMITS.sessionTtlMs).toISOString(), lastSeenAt: nowIso,
    });
    await store.touchUser(user.id, nowIso);

    res.setHeader('Set-Cookie', sessionCookie(token, { secure: cookieSecure(req), maxAgeMs: AUTH_LIMITS.sessionTtlMs }));
    res.json({ ok: true, user: publicUser(user) });
  });

  /**
   * Forgot Password / Reset PIN with OTP code.
   */
  app.post('/api/auth/reset-password', async (req, res) => {
    const phone = typeof req.body?.phone === 'string' ? normalizeTzPhone(req.body.phone) : null;
    const code = req.body?.code;
    const newPin = typeof req.body?.newPin === 'string' && req.body.newPin.length >= 4 ? req.body.newPin : null;
    if (!phone || !looksLikeCode(code) || !newPin) return void res.status(400).json({ error: 'bad_request' });

    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();
    const live = await store.liveCode(phone, nowIso);
    if (!live) return void res.status(401).json({ error: 'bad_code' });
    if (!hashesEqual(live.codeHash, hashCode(AUTH_SECRET, phone, code))) {
      return void res.status(401).json({ error: 'bad_code' });
    }

    await store.consumeCode(live.id, nowIso);
    let user = await store.findUserByPhone(phone);
    if (!user) return void res.status(404).json({ error: 'user_not_found' });

    user.pinHash = hashPin(AUTH_SECRET, newPin);
    // Persist updated user
    await store.createUser(user);

    const token = generateToken();
    await store.createSession({
      tokenHash: hashToken(AUTH_SECRET, token), userId: user.id,
      createdAt: nowIso, expiresAt: new Date(nowMs + AUTH_LIMITS.sessionTtlMs).toISOString(), lastSeenAt: nowIso,
    });

    res.setHeader('Set-Cookie', sessionCookie(token, { secure: cookieSecure(req), maxAgeMs: AUTH_LIMITS.sessionTtlMs }));
    res.json({ ok: true, user: publicUser(user) });
  });

  /**
   * Check a code and start a session. Wrong codes are counted; after AUTH_LIMITS.maxAttempts the code is
   * dead and a new one must be requested. The code is compared as a hash, in constant time.
   */
  app.post('/api/auth/verify', async (req, res) => {
    const phone = typeof req.body?.phone === 'string' ? normalizeTzPhone(req.body.phone) : null;
    const code = req.body?.code;
    if (!phone || !looksLikeCode(code)) return void res.status(400).json({ error: 'bad_request' });
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();

    const live = await store.liveCode(phone, nowIso);
    // One answer for "no code", "expired" and "wrong code": nothing here tells an attacker which it was.
    if (!live) return void res.status(401).json({ error: 'bad_code' });
    if (live.attempts >= AUTH_LIMITS.maxAttempts) {
      await store.consumeCode(live.id, nowIso);
      return void res.status(429).json({ error: 'too_many_attempts' });
    }
    if (!hashesEqual(live.codeHash, hashCode(AUTH_SECRET, phone, code))) {
      const attempts = await store.bumpCodeAttempts(live.id);
      if (attempts >= AUTH_LIMITS.maxAttempts) await store.consumeCode(live.id, nowIso);
      return void res.status(401).json({ error: 'bad_code', attemptsLeft: Math.max(0, AUTH_LIMITS.maxAttempts - attempts) });
    }

    // Single use: consume before anything else can race on it.
    await store.consumeCode(live.id, nowIso);

    const requestedName = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : undefined;
    const requestedPin = typeof req.body?.pin === 'string' && req.body.pin.length >= 4 ? req.body.pin : undefined;

    let user = await store.findUserByPhone(phone);
    if (!user) {
      user = await store.createUser({
        id: `u-${shortId()}`,
        phone,
        name: requestedName,
        role: roleForPhone(env, phone),
        pinHash: requestedPin ? hashPin(AUTH_SECRET, requestedPin) : undefined,
        createdAt: nowIso,
        disabled: false,
      });
    } else if (requestedName || requestedPin) {
      if (requestedName) user.name = requestedName;
      if (requestedPin) user.pinHash = hashPin(AUTH_SECRET, requestedPin);
      await store.createUser(user);
    }

    if (user.disabled) return void res.status(403).json({ error: 'account_disabled' });

    const token = generateToken();
    await store.createSession({
      tokenHash: hashToken(AUTH_SECRET, token), userId: user.id,
      createdAt: nowIso, expiresAt: new Date(nowMs + AUTH_LIMITS.sessionTtlMs).toISOString(), lastSeenAt: nowIso,
    });
    await store.touchUser(user.id, nowIso);
    // Housekeeping, cheap and best effort.
    await store.deleteExpiredSessions(nowIso).catch(() => 0);

    res.setHeader('Set-Cookie', sessionCookie(token, { secure: cookieSecure(req), maxAgeMs: AUTH_LIMITS.sessionTtlMs }));
    res.json({ ok: true, user: publicUser(user) });
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = readCookie(req.headers.cookie);
    if (token) await store.deleteSession(hashToken(AUTH_SECRET, token));
    res.setHeader('Set-Cookie', clearedCookie(cookieSecure(req)));
    res.json({ ok: true });
  });

  // ---------------- Sync: idempotent by id, with chain checkpoints ----------------
  app.post('/api/sync', requireAuth('farmer', 'extension'), async (req, res) => {
    const { farmId, records } = req.body ?? {};
    if (typeof farmId !== 'string' || !farmId || farmId.length > 120 || !Array.isArray(records) || records.length > 5000) return void res.status(400).json({ error: 'bad_request' });
    const bad = records.findIndex((r: unknown) => !validateReading(r) || (r as Reading).farmId !== farmId);
    if (bad >= 0) return void res.status(400).json({ error: 'invalid_record', index: bad });
    const { accepted, duplicates, conflicts, list } = await store.syncRecords(farmId, records as Reading[]);
    const chain = await verifyChain(list);
    const head = list[list.length - 1];
    let checkpoint: Checkpoint | null = null;
    const last = await store.latestCheckpoint(farmId);
    if (head && (!last || last.headHash !== head.hash || last.chainOk !== chain.ok)) {
      checkpoint = { receivedAt: new Date(now()).toISOString(), farmId, headHash: head.hash, headSeq: head.seq, count: list.length, chainOk: chain.ok, brokenAtSeq: chain.brokenAtSeq };
      await store.addCheckpoint(checkpoint);
    }
    res.json({ accepted, duplicates, conflicts, chain: { ok: chain.ok, brokenAtSeq: chain.brokenAtSeq, count: chain.count, headHash: chain.headHash }, checkpoint: checkpoint ?? last ?? null });
  });

  app.get('/api/checkpoints', requireAuth(), async (req, res) => {
    const farmId = typeof req.query.farmId === 'string' ? req.query.farmId : null;
    const newestFirst = await store.listCheckpoints(farmId, 50);
    res.json({ checkpoints: newestFirst, latest: newestFirst[0] ?? null, note: 'First step, not an independent anchor: the server that stores the checkpoints is the same one that holds the records.' });
  });

  // ---------------- Settings (phone stored on the server only when the user saves) ----------------
  /**
   * Whose settings these are. With sign-in on, each user has their own phone number and language, so one
   * farmer's number is never shown to another. With sign-in off the demo keeps its single shared row.
   */
  const settingsOf = (req: Request) => {
    const u = authOn ? currentUser(req) : null;
    return u
      ? { get: () => store.getUserSettings(u.id), put: (p: Parameters<AppStore['putSettings']>[0]) => store.putUserSettings(u.id, p) }
      : { get: () => store.getSettings(), put: (p: Parameters<AppStore['putSettings']>[0]) => store.putSettings(p) };
  };

  const settingsView = (st: { phone?: string; smsLang?: Lang }) => ({
    hasPhone: !!st.phone,
    phoneMasked: st.phone ? maskPhone(st.phone) : null,
    smsLang: st.smsLang ?? 'sw',
    sms: { mode: beemConfigured(beemEnv) ? 'configured' : 'dry-run' },
  });
  app.get('/api/settings', requireAuth(), async (req, res) => res.json(settingsView(await settingsOf(req).get())));
  app.put('/api/settings', requireAuth(), async (req, res) => {
    const { phone, smsLang } = req.body ?? {};
    const patch: { phone?: string; smsLang?: Lang; clearPhone?: boolean } = {};
    if (smsLang !== undefined) {
      if (smsLang !== 'sw' && smsLang !== 'en') return void res.status(400).json({ error: 'bad_lang' });
      patch.smsLang = smsLang;
    }
    if (phone !== undefined) {
      if (phone === null || phone === '') patch.clearPhone = true;
      else {
        const n = typeof phone === 'string' ? normalizeTzPhone(phone) : null;
        if (!n) return void res.status(400).json({ error: 'bad_phone' });
        patch.phone = n;
      }
    }
    res.json(settingsView(await settingsOf(req).put(patch)));
  });

  // ---------------- SMS ----------------
  const logSms = (e: Omit<SmsLogEntry, 'at'>) => store.addSms({ ...e, at: new Date(now()).toISOString() });

  app.get('/api/sms/status', requireAuth(), (_req, res) => {
    const configured = beemConfigured(beemEnv);
    res.json({ mode: configured ? 'configured' : 'dry-run', senderIdSet: !!(env.BEEM_SENDER_ID || '').trim(), live: configured && beemSession.lastOkAt !== null, lastOkAt: beemSession.lastOkAt, lastAttempt: beemSession.lastAttempt, maxPerHour: maxSmsPerHour });
  });
  app.get('/api/sms/log', requireAuth(), async (_req, res) => res.json({ log: await store.listSms(50) }));
  app.post('/api/sms/balance', requireAuth(), async (_req, res) => {
    if (!beemConfigured(beemEnv)) return void res.status(400).json({ error: 'not_configured' });
    const r = await checkBalance({ env: beemEnv, fetchImpl: opts.fetchImpl });
    if (r.success) beemSession.lastOkAt = new Date(now()).toISOString();
    res.json(r);
  });

  /**
   * Beem health. Runs the documented balance check and reports three separate facts:
   *   configured  credentials and a sender ID are present on the server
   *   reachable   Beem answered at all (tells a network problem apart from rejected credentials)
   *   balance     the SMS credit Beem reported
   * Never returns the key, the secret or the sender ID itself, only whether they are usable.
   * With no credentials this answers honestly instead of failing: configured false, and nothing is called.
   */
  app.get('/api/sms/health', requireAuth(), async (_req, res) => {
    const configured = beemConfigured(beemEnv);
    const senderIssue = senderIdIssue(env.BEEM_SENDER_ID);
    const base = {
      configured,
      senderIdSet: senderIssue !== 'missing',
      senderIdIssue: senderIssue,
      mode: configured ? ('configured' as const) : ('dry-run' as const),
      live: configured && beemSession.lastOkAt !== null,
      lastOkAt: beemSession.lastOkAt,
      maxPerHour: maxSmsPerHour,
      checkedAt: new Date(now()).toISOString(),
    };
    if (!configured) {
      // Nothing is called and nothing is claimed: no credentials means dry run, not "unhealthy".
      return void res.json({ ...base, reachable: null, balance: null, error: 'not_configured' });
    }
    const r = await checkBalance({ env: beemEnv, fetchImpl: opts.fetchImpl });
    if (r.success) beemSession.lastOkAt = new Date(now()).toISOString();
    res.json({
      ...base,
      live: r.success || base.live,
      lastOkAt: r.success ? new Date(now()).toISOString() : base.lastOkAt,
      reachable: r.reachable ?? false,
      balance: r.success ? (r.balance ?? null) : null,
      httpStatus: r.httpStatus,
      error: r.success ? undefined : r.error,
    });
  });

  // ---------------- Delivery reports ----------------
  /** Find the log entry a report belongs to: Beem's own request_id first, then our own request id. */
  const findSmsForDlr = async (dlrId: string | null) => (dlrId ? store.findSmsForDlr(dlrId) : null);

  /**
   * Delivery-report callback. Beem POSTs inbound messages and delivery reports to a callback URL you register
   * with them; this is the endpoint to give them for reports. UNVERIFIED: no callback has ever reached this build.
   *
   * It only ever updates the delivery state of a message this server already sent. It cannot create a record,
   * send anything, or change a reading. A report it cannot match is kept in `unmatchedDlr` so the gap is visible.
   * Set BEEM_DLR_TOKEN to require `?token=` on the URL you give Beem; without it the endpoint is open, which is
   * fine for a demo on a laptop and NOT fine on the public internet.
   */
  // NOT behind requireAuth, deliberately: Beem calls this, and Beem has no session. Its guard is
  // BEEM_DLR_TOKEN, and all it can ever do is set the delivery state of a message this server already sent.
  app.post('/api/sms/dlr', async (req, res) => {
    const wantToken = (env.BEEM_DLR_TOKEN ?? '').trim();
    if (wantToken && req.query.token !== wantToken) return void res.status(403).json({ error: 'forbidden' });
    const parsed = parseDlrCallback(req.body);
    if (!parsed) {
      // Not a delivery report (or a shape we have never seen). Say so rather than inventing a status.
      return void res.status(400).json({ error: 'not_a_delivery_report' });
    }
    const at = new Date(now()).toISOString();
    const entry = await findSmsForDlr(parsed.dlrId);
    if (!entry) {
      await store.addUnmatchedDlr({ at, dlrId: parsed.dlrId, raw: parsed.report.raw });
      // Beem wants a 200 acknowledgement even when we could not use the report, or it will keep resending.
      return void res.status(200).json({ ok: true, matched: false });
    }
    await store.setSmsDelivery(entry.id, { state: parsed.report.state, raw: parsed.report.raw, at, via: 'callback' });
    res.status(200).json({ ok: true, matched: true });
  });

  /**
   * Ask Beem about messages we sent but have no report for. Beem asks callers to wait at least 5 minutes
   * after sending, so anything younger than that is left alone and reported as too_recent.
   * Only ever reads: it cannot send an SMS.
   */
  app.post('/api/sms/dlr/poll', requireAuth(), async (req, res) => {
    if (!beemConfigured(beemEnv)) return void res.status(400).json({ error: 'not_configured' });
    const { phone } = await settingsOf(req).get();
    if (!phone) return void res.status(400).json({ error: 'no_phone' });
    const pending = await store.pendingDeliveries(10);
    let checked = 0, updated = 0, tooRecent = 0;
    for (const e of pending) {
      if (now() - Date.parse(e.at) < DLR_MIN_POLL_DELAY_MS) { tooRecent++; continue; }
      checked++;
      const r = await getDeliveryReport({ destAddr: phone, requestId: e.beemRequestId! }, { env: beemEnv, fetchImpl: opts.fetchImpl });
      if (!r.success || !r.report) continue;
      await store.setSmsDelivery(e.id, { state: r.report.state, raw: r.report.raw, at: new Date(now()).toISOString(), via: 'poll' });
      updated++;
    }
    res.json({ pending: pending.length, checked, updated, tooRecent, minDelayMinutes: DLR_MIN_POLL_DELAY_MS / 60000 });
  });

  /**
   * Send an SMS from a TEMPLATE (never free text) to the phone number saved in Settings. Idempotent by requestId.
   * The demo has no sign-in, so this is rate-limited and only ever sends to the saved number.
   */
  app.post('/api/sms/send', requireAuth('farmer'), async (req, res) => {
    const { kind, lang, template, params, requestId, alertId } = req.body ?? {};
    if ((kind !== 'test' && kind !== 'alert') || (lang !== 'sw' && lang !== 'en') || typeof requestId !== 'string' || !requestId || requestId.length > 160) return void res.status(400).json({ error: 'bad_request' });
    const templateId: SmsTemplateId = kind === 'test' ? 'test' : template;
    if (!ALL_TEMPLATE_IDS.includes(templateId) || templateId === 'inbound_ok' || templateId === 'inbound_error') return void res.status(400).json({ error: 'bad_template' });
    const dup = await store.getSms(requestId);
    if (dup) return void res.json({ state: dup.state, requestId, duplicate: true, dryRun: dup.state === 'dry_run', error: dup.error });
    const { phone } = await settingsOf(req).get();
    if (!phone) return void res.status(400).json({ error: 'no_phone' });
    const p: SmsParams = {};
    for (const k of ['cage', 'value', 'delta', 'hours'] as const) if (params && typeof params[k] === 'number' && Number.isFinite(params[k])) p[k] = params[k];
    if (params && typeof params.low === 'boolean') p.low = params.low;
    const message = renderSms(templateId, lang as Lang, p);
    if (smsLength(message) > SMS_MAX || !isGsm7(message)) return void res.status(400).json({ error: 'message_not_sendable' });
    const configured = beemConfigured(beemEnv);
    if (configured) {
      const hourAgo = new Date(now() - 3600_000).toISOString();
      // Alerts and tests only: sign-in codes have their own ceiling and must not eat this budget.
      const recent = await store.countSmsSince(hourAgo, ['sent', 'failed'], ['test', 'alert']);
      if (recent >= maxSmsPerHour) return void res.status(429).json({ error: 'rate_limited', maxPerHour: maxSmsPerHour });
    }
    const r = await sendSMSWithRetry({ to: phone, message }, { env: beemEnv, fetchImpl: opts.fetchImpl, sleep: opts.sleep });
    const state: SmsState = r.dryRun ? 'dry_run' : r.success ? 'sent' : 'failed';
    if (!r.dryRun) beemSession.lastAttempt = { at: new Date(now()).toISOString(), state };
    if (r.success) beemSession.lastOkAt = new Date(now()).toISOString();
    await logSms({ id: requestId, kind, state, lang, chars: smsLength(message), alertId: typeof alertId === 'string' ? alertId : undefined, error: r.success || r.dryRun ? undefined : r.error, beemRequestId: r.requestId === undefined ? undefined : String(r.requestId) });
    res.json({ state, requestId, dryRun: !!r.dryRun, message, chars: smsLength(message), error: r.success || r.dryRun ? undefined : r.error });
  });

  /**
   * SIMULATED inbound SMS. Real inbound needs Beem inbound to be configured (a gap to ask Beem about).
   * A parsed command becomes a draft in the inbox; the app pulls it into its own hash chain on the next sync.
   */
  app.post('/api/sms/inbound', requireAuth('farmer'), async (req, res) => {
    const { text, from } = req.body ?? {};
    if (typeof text !== 'string' || text.length > 400) return void res.status(400).json({ error: 'bad_request' });
    const { phone: saved } = await settingsOf(req).get();
    if (typeof from === 'string' && from) {
      const n = normalizeTzPhone(from);
      if (!n || (saved && n !== saved)) return void res.status(403).json({ ok: false, error: 'unknown_sender' });
    }
    const p = parseInboundSms(text);
    if (!p.ok) return void res.json({ ok: false, simulated: true, error: p.error, field: p.field, reply: renderSms('inbound_error', p.lang ?? 'sw') });
    if (p.cageNumber > demoCageCount) return void res.json({ ok: false, simulated: true, error: 'bad_cage', field: `K${p.cageNumber}`, reply: renderSms('inbound_error', p.lang) });
    const ts = new Date(now()).toISOString();
    const cageId = `${DEMO_FARM_ID}-c${p.cageNumber}`;
    const map: [keyof typeof p.values, Kind, string][] = [['do', 'do', 'mg/L'], ['temp', 'temp', '°C'], ['ph', 'ph', 'pH'], ['feed', 'feed', 'kg'], ['dead', 'mortality', 'fish']];
    const queuedItems = [];
    for (const [k, kind, unit] of map) {
      const v = p.values[k];
      if (v === undefined) continue;
      const draft: ReadingDraft = { cageId, farmId: DEMO_FARM_ID, kind, value: v, unit, ts, source: 'manual', via: 'sms', demo: true };
      queuedItems.push({ id: `in-${shortId()}`, receivedAt: ts, draft });
    }
    await store.addInbox(queuedItems);
    const queued = queuedItems.length;
    res.json({ ok: true, simulated: true, queued, cageNumber: p.cageNumber, lang: p.lang, reply: renderSms('inbound_ok', p.lang, { cage: p.cageNumber, summary: p.summary }) });
  });
  app.get('/api/inbox', requireAuth('farmer'), async (_req, res) => res.json({ items: await store.listInbox() }));
  app.post('/api/inbox/ack', requireAuth('farmer'), async (req, res) => {
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids)) return void res.status(400).json({ error: 'bad_request' });
    res.json({ remaining: await store.ackInbox(ids.filter((x): x is string => typeof x === 'string')) });
  });

  // ---------------- Box ----------------
  app.get('/api/box/status', requireAuth(), (_req, res) => res.json(box.status()));
  app.post('/api/box/test', requireAuth(), async (_req, res) => res.json(await box.test()));
  app.get('/api/box/weather', requireAuth(), async (req, res) => {
    const lat = req.query.lat === undefined ? DEMO_POINT.lat : Number(req.query.lat);
    const lon = req.query.lon === undefined ? DEMO_POINT.lon : Number(req.query.lon);
    if (!boxPointValid(lat, lon)) return void res.status(400).json({ error: 'out_of_range', range: 'lat -5.1..2.5, lon 28.95..36.7' });
    res.json(await box.weather(lat, lon));
  });
  app.get('/api/box/devices', requireAuth(), async (_req, res) => res.json(await box.devices()));

  // ---------------- Demo reset (demo only) ----------------
  app.post('/api/demo/reset', requireAuth(), async (_req, res) => {
    // Keeps the saved phone number and SMS language; clears synced records, checkpoints, log and inbox.
    await store.reset();
    res.json({ ok: true });
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) return void res.status(400).json({ error: 'bad_json' });
    if (err?.type === 'entity.too.large') return void res.status(413).json({ error: 'too_large' });
    res.status(500).json({ error: 'server_error' }); // never echo internals
  });
  return { app, store, box };
}
