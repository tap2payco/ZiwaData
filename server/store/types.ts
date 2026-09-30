import type { Checkpoint, Lang, Reading, ReadingDraft, SmsState } from '../../src/core/types';
import type { DeliveryState } from '../sms/beem';
import type { Role } from '../auth/auth';

/**
 * The one storage interface. Two implementations: JsonStore (a file, for the demo and for tests) and
 * PgStore (Postgres, for a pilot). Routes talk only to this, so swapping the backing store changes no route.
 *
 * Every method is async, because Postgres is. The JSON store satisfies that trivially.
 */

export interface SmsDelivery {
  state: DeliveryState;
  raw: string;
  at: string;
  via: 'callback' | 'poll';
}
export interface SmsLogEntry {
  id: string;
  at: string;
  kind: 'test' | 'alert' | 'inbound_reply' | 'auth';
  state: SmsState;
  lang: Lang;
  chars: number;
  alertId?: string;
  error?: string;
  /** Beem's own request_id from the send response. The only handle we have for asking about delivery. */
  beemRequestId?: string;
  /** What Beem later said. Absent until a report arrives: absent is NOT "delivered". */
  delivery?: SmsDelivery;
}
export interface InboundDraft {
  id: string;
  receivedAt: string;
  draft: ReadingDraft;
}
export interface UnmatchedDlr {
  at: string;
  dlrId: string | null;
  raw: string;
}
export interface Settings {
  phone?: string;
  smsLang?: Lang;
}

/** What a sync attempt did. `list` is the farm's whole chain afterwards, in seq order, ready to verify. */
export interface SyncOutcome {
  accepted: number;
  duplicates: number;
  /** Ids refused because another record already holds that position in the chain. */
  conflicts: string[];
  list: Reading[];
}

/** A person who can sign in. The phone number is the identity. */
export interface User {
  id: string;
  phone: string;
  name?: string;
  role: Role;
  pinHash?: string;
  createdAt: string;
  lastSeenAt?: string;
  /** Tanzania Personal Data Protection Act 2022. Absent until they have agreed. */
  consentAt?: string;
  consentVersion?: string;
  disabled: boolean;
}
/** A one-time code. `codeHash` only: the code itself is never stored. */
export interface AuthCode {
  id: string;
  phone: string;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  attempts: number;
  consumedAt?: string;
}
/** A signed-in browser. `tokenHash` only: the token lives in the user's cookie. */
export interface Session {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

export interface AppStore {
  // ---- Users ----
  findUserByPhone(phone: string): Promise<User | null>;
  getUser(id: string): Promise<User | null>;
  createUser(user: User): Promise<User>;
  touchUser(id: string, atIso: string): Promise<void>;
  setConsent(id: string, atIso: string, version: string): Promise<void>;

  // ---- One-time codes ----
  /** Store a new code for this number, retiring any code still live for it. */
  putCode(code: AuthCode): Promise<void>;
  /** The code still usable for this number: not consumed and not past `nowIso`. */
  liveCode(phone: string, nowIso: string): Promise<AuthCode | null>;
  /** Codes requested for this number at or after `sinceIso`, for the hourly limit. */
  countCodesSince(phone: string, sinceIso: string): Promise<number>;
  /** The most recent code request for this number, used or not, for the resend gap. */
  lastCodeAt(phone: string): Promise<string | null>;
  bumpCodeAttempts(id: string): Promise<number>;
  consumeCode(id: string, atIso: string): Promise<void>;

  // ---- Sessions ----
  createSession(session: Session): Promise<void>;
  findSession(tokenHash: string, nowIso: string): Promise<{ session: Session; user: User } | null>;
  touchSession(tokenHash: string, atIso: string): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  /** Housekeeping: drop sessions that have run out. */
  deleteExpiredSessions(nowIso: string): Promise<number>;

  // ---- Per-user settings (used once sign-in is on; the single-row settings stay for the demo) ----
  getUserSettings(userId: string): Promise<Settings>;
  putUserSettings(userId: string, patch: Settings & { clearPhone?: boolean }): Promise<Settings>;

  // ---- Records ----
  /**
   * Append records to a farm's chain. MUST be idempotent by record id: re-sending the same records
   * accepts nothing and reports them as duplicates. A record whose seq is already held by a different
   * id is refused as a conflict, never overwritten.
   */
  syncRecords(farmId: string, records: Reading[]): Promise<SyncOutcome>;
  getRecords(farmId: string): Promise<Reading[]>;

  // ---- Checkpoints ----
  latestCheckpoint(farmId: string): Promise<Checkpoint | null>;
  addCheckpoint(cp: Checkpoint): Promise<void>;
  /** Newest first. */
  listCheckpoints(farmId: string | null, limit: number): Promise<Checkpoint[]>;

  // ---- Settings ----
  getSettings(): Promise<Settings>;
  putSettings(patch: Settings & { clearPhone?: boolean }): Promise<Settings>;

  // ---- SMS ----
  addSms(entry: SmsLogEntry): Promise<void>;
  getSms(id: string): Promise<SmsLogEntry | null>;
  /** Newest first. */
  listSms(limit: number): Promise<SmsLogEntry[]>;
  /**
   * How many messages in these states were logged after `sinceIso`. Feeds the hourly caps.
   * `kinds` narrows it: the alert budget and the sign-in-code budget are counted separately, so a farmer
   * who mistypes their number five times does not lose their low-oxygen alerts for the next hour.
   */
  countSmsSince(sinceIso: string, states: SmsState[], kinds?: SmsLogEntry['kind'][]): Promise<number>;
  /** Match a delivery report: Beem's own request_id first, then our own request id. Newest match wins. */
  findSmsForDlr(dlrId: string): Promise<SmsLogEntry | null>;
  setSmsDelivery(id: string, delivery: SmsDelivery): Promise<void>;
  /** Sent messages with a Beem request id and no final delivery report yet. Oldest first. */
  pendingDeliveries(limit: number): Promise<SmsLogEntry[]>;

  // ---- Inbox ----
  addInbox(items: InboundDraft[]): Promise<void>;
  listInbox(): Promise<InboundDraft[]>;
  /** Removes the given ids. Returns how many are left. */
  ackInbox(ids: string[]): Promise<number>;

  // ---- Unmatched delivery reports ----
  addUnmatchedDlr(x: UnmatchedDlr): Promise<void>;
  listUnmatchedDlr(): Promise<UnmatchedDlr[]>;

  // ---- Admin ----
  /**
   * Demo reset: clears records, checkpoints, SMS log, inbox and unmatched reports.
   * Settings, accounts and sessions are KEPT, so resetting the demo does not sign everyone out.
   */
  reset(): Promise<void>;
  /**
   * Everything, accounts and sessions included. For tests and for wiping a development database.
   * Never call this from a route: it deletes who everybody is.
   */
  resetAll(): Promise<void>;
  close(): Promise<void>;
  /** For the startup banner and tests. Never includes a credential. */
  describe(): string;
}

/** How many entries each capped list keeps, so a long-running demo cannot grow without bound. */
export const LIMITS = { smsLog: 200, checkpoints: 500, unmatchedDlr: 100 } as const;
