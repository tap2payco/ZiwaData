import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Checkpoint, Reading, SmsState } from '../../src/core/types';
import { LIMITS, type AppStore, type AuthCode, type InboundDraft, type Session, type Settings, type SmsDelivery, type SmsLogEntry, type SyncOutcome, type UnmatchedDlr, type User } from './types';

/**
 * JSON-file store in server/data/ (gitignored). No native modules, nothing to install.
 * Fine for the demo and for tests; not a database. A pilot should use PgStore.
 */
export interface Db {
  records: Record<string, Reading[]>;
  checkpoints: Checkpoint[];
  settings: Settings;
  smsLog: SmsLogEntry[];
  inbox: InboundDraft[];
  unmatchedDlr: UnmatchedDlr[];
  users: User[];
  authCodes: AuthCode[];
  sessions: Session[];
  userSettings: Record<string, Settings>;
}
const empty = (): Db => ({ records: {}, checkpoints: [], settings: {}, smsLog: [], inbox: [], unmatchedDlr: [], users: [], authCodes: [], sessions: [], userSettings: {} });

export class JsonStore implements AppStore {
  db: Db;
  private file: string;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'db.json');
    this.db = empty();
    if (existsSync(this.file)) {
      try {
        this.db = { ...empty(), ...JSON.parse(readFileSync(this.file, 'utf8')) };
      } catch {
        // A corrupt file must not stop the server: keep it aside and start clean.
        try { renameSync(this.file, this.file + '.corrupt-' + Date.now()); } catch { /* ignore */ }
      }
    }
  }
  /** Atomic write: temp file then rename. */
  private save() {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.db));
    renameSync(tmp, this.file);
  }

  // ---- Users ----
  async findUserByPhone(phone: string): Promise<User | null> {
    return this.db.users.find((u) => u.phone === phone) ?? null;
  }
  async getUser(id: string): Promise<User | null> {
    return this.db.users.find((u) => u.id === id) ?? null;
  }
  async createUser(user: User): Promise<User> {
    this.db.users.push(user);
    this.save();
    return user;
  }
  async touchUser(id: string, atIso: string): Promise<void> {
    const u = this.db.users.find((x) => x.id === id);
    if (!u) return;
    u.lastSeenAt = atIso;
    this.save();
  }
  async setConsent(id: string, atIso: string, version: string): Promise<void> {
    const u = this.db.users.find((x) => x.id === id);
    if (!u) return;
    u.consentAt = atIso; u.consentVersion = version;
    this.save();
  }

  // ---- One-time codes ----
  async putCode(code: AuthCode): Promise<void> {
    // At most one live code per number: a new request retires whatever was outstanding. Retire, never
    // delete: countCodesSince counts these rows, and deleting them would throw away the rate limit.
    for (const c of this.db.authCodes) if (c.phone === code.phone && !c.consumedAt) c.consumedAt = code.createdAt;
    this.db.authCodes.push(code);
    if (this.db.authCodes.length > 500) this.db.authCodes.splice(0, this.db.authCodes.length - 500);
    this.save();
  }
  async liveCode(phone: string, nowIso: string): Promise<AuthCode | null> {
    const now = Date.parse(nowIso);
    return this.db.authCodes.find((c) => c.phone === phone && !c.consumedAt && Date.parse(c.expiresAt) > now) ?? null;
  }
  async countCodesSince(phone: string, sinceIso: string): Promise<number> {
    const since = Date.parse(sinceIso);
    return this.db.authCodes.filter((c) => c.phone === phone && Date.parse(c.createdAt) >= since).length;
  }
  async lastCodeAt(phone: string): Promise<string | null> {
    const mine = this.db.authCodes.filter((c) => c.phone === phone);
    return mine.length ? mine[mine.length - 1]!.createdAt : null;
  }
  async bumpCodeAttempts(id: string): Promise<number> {
    const c = this.db.authCodes.find((x) => x.id === id);
    if (!c) return 0;
    c.attempts += 1;
    this.save();
    return c.attempts;
  }
  async consumeCode(id: string, atIso: string): Promise<void> {
    const c = this.db.authCodes.find((x) => x.id === id);
    if (!c) return;
    c.consumedAt = atIso;
    this.save();
  }

  // ---- Sessions ----
  async createSession(session: Session): Promise<void> {
    this.db.sessions.push(session);
    this.save();
  }
  async findSession(tokenHash: string, nowIso: string): Promise<{ session: Session; user: User } | null> {
    const now = Date.parse(nowIso);
    const s = this.db.sessions.find((x) => x.tokenHash === tokenHash && Date.parse(x.expiresAt) > now);
    if (!s) return null;
    const user = this.db.users.find((u) => u.id === s.userId);
    if (!user || user.disabled) return null;
    return { session: s, user };
  }
  async touchSession(tokenHash: string, atIso: string): Promise<void> {
    const s = this.db.sessions.find((x) => x.tokenHash === tokenHash);
    if (!s) return;
    s.lastSeenAt = atIso;
    this.save();
  }
  async deleteSession(tokenHash: string): Promise<void> {
    this.db.sessions = this.db.sessions.filter((s) => s.tokenHash !== tokenHash);
    this.save();
  }
  async deleteExpiredSessions(nowIso: string): Promise<number> {
    const now = Date.parse(nowIso);
    const before = this.db.sessions.length;
    this.db.sessions = this.db.sessions.filter((s) => Date.parse(s.expiresAt) > now);
    const gone = before - this.db.sessions.length;
    if (gone) this.save();
    return gone;
  }

  // ---- Per-user settings ----
  async getUserSettings(userId: string): Promise<Settings> {
    return { ...(this.db.userSettings[userId] ?? {}) };
  }
  async putUserSettings(userId: string, patch: Settings & { clearPhone?: boolean }): Promise<Settings> {
    const cur = (this.db.userSettings[userId] ??= {});
    if (patch.smsLang !== undefined) cur.smsLang = patch.smsLang;
    if (patch.clearPhone) delete cur.phone;
    else if (patch.phone !== undefined) cur.phone = patch.phone;
    this.save();
    return { ...cur };
  }

  // ---- Records ----
  async syncRecords(farmId: string, records: Reading[]): Promise<SyncOutcome> {
    const list = (this.db.records[farmId] ??= []);
    const byId = new Set(list.map((r) => r.id));
    const bySeq = new Map(list.map((r) => [r.seq, r.id]));
    let accepted = 0, duplicates = 0;
    const conflicts: string[] = [];
    for (const r of records) {
      if (byId.has(r.id)) { duplicates++; continue; }
      const existing = bySeq.get(r.seq);
      if (existing && existing !== r.id) { conflicts.push(r.id); continue; }
      list.push(r); byId.add(r.id); bySeq.set(r.seq, r.id); accepted++;
    }
    list.sort((a, b) => a.seq - b.seq);
    if (accepted) this.save();
    return { accepted, duplicates, conflicts, list: [...list] };
  }
  async getRecords(farmId: string): Promise<Reading[]> {
    return [...(this.db.records[farmId] ?? [])];
  }

  // ---- Checkpoints ----
  async latestCheckpoint(farmId: string): Promise<Checkpoint | null> {
    return [...this.db.checkpoints].reverse().find((c) => c.farmId === farmId) ?? null;
  }
  async addCheckpoint(cp: Checkpoint): Promise<void> {
    this.db.checkpoints.push(cp);
    if (this.db.checkpoints.length > LIMITS.checkpoints) this.db.checkpoints.splice(0, this.db.checkpoints.length - LIMITS.checkpoints);
    this.save();
  }
  async listCheckpoints(farmId: string | null, limit: number): Promise<Checkpoint[]> {
    return [...this.db.checkpoints].filter((c) => !farmId || c.farmId === farmId).reverse().slice(0, limit);
  }

  // ---- Settings ----
  async getSettings(): Promise<Settings> {
    return { ...this.db.settings };
  }
  async putSettings(patch: Settings & { clearPhone?: boolean }): Promise<Settings> {
    if (patch.smsLang !== undefined) this.db.settings.smsLang = patch.smsLang;
    if (patch.clearPhone) delete this.db.settings.phone;
    else if (patch.phone !== undefined) this.db.settings.phone = patch.phone;
    this.save();
    return { ...this.db.settings };
  }

  // ---- SMS ----
  async addSms(entry: SmsLogEntry): Promise<void> {
    this.db.smsLog.push(entry);
    if (this.db.smsLog.length > LIMITS.smsLog) this.db.smsLog.splice(0, this.db.smsLog.length - LIMITS.smsLog);
    this.save();
  }
  async getSms(id: string): Promise<SmsLogEntry | null> {
    return this.db.smsLog.find((e) => e.id === id) ?? null;
  }
  async listSms(limit: number): Promise<SmsLogEntry[]> {
    return [...this.db.smsLog].reverse().slice(0, limit);
  }
  async countSmsSince(sinceIso: string, states: SmsState[], kinds?: SmsLogEntry['kind'][]): Promise<number> {
    const since = Date.parse(sinceIso);
    return this.db.smsLog.filter((e) => states.includes(e.state) && (!kinds || kinds.includes(e.kind)) && Date.parse(e.at) > since).length;
  }
  async findSmsForDlr(dlrId: string): Promise<SmsLogEntry | null> {
    return [...this.db.smsLog].reverse().find((e) => e.beemRequestId === dlrId || e.id === dlrId) ?? null;
  }
  async setSmsDelivery(id: string, delivery: SmsDelivery): Promise<void> {
    const e = this.db.smsLog.find((x) => x.id === id);
    if (!e) return;
    e.delivery = delivery;
    this.save();
  }
  async pendingDeliveries(limit: number): Promise<SmsLogEntry[]> {
    return this.db.smsLog.filter((e) => e.state === 'sent' && e.beemRequestId && (!e.delivery || e.delivery.state === 'pending')).slice(-limit);
  }

  // ---- Inbox ----
  async addInbox(items: InboundDraft[]): Promise<void> {
    this.db.inbox.push(...items);
    this.save();
  }
  async listInbox(): Promise<InboundDraft[]> {
    return [...this.db.inbox];
  }
  async ackInbox(ids: string[]): Promise<number> {
    const set = new Set(ids);
    this.db.inbox = this.db.inbox.filter((i) => !set.has(i.id));
    this.save();
    return this.db.inbox.length;
  }

  // ---- Unmatched delivery reports ----
  async addUnmatchedDlr(x: UnmatchedDlr): Promise<void> {
    this.db.unmatchedDlr.push(x);
    if (this.db.unmatchedDlr.length > LIMITS.unmatchedDlr) this.db.unmatchedDlr.splice(0, this.db.unmatchedDlr.length - LIMITS.unmatchedDlr);
    this.save();
  }
  async listUnmatchedDlr(): Promise<UnmatchedDlr[]> {
    return [...this.db.unmatchedDlr];
  }

  // ---- Admin ----
  async reset(): Promise<void> {
    // Demo reset clears the demo data. Accounts and sessions are NOT demo data: a reset must not
    // sign every farmer out or delete who they are.
    const { settings, users, authCodes, sessions, userSettings } = this.db;
    this.db = { ...empty(), settings, users, authCodes, sessions, userSettings };
    this.save();
  }
  async resetAll(): Promise<void> {
    this.db = empty();
    this.save();
  }
  async close(): Promise<void> { /* nothing to close */ }
  describe(): string { return `JSON file (${this.file})`; }
}
