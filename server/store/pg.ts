import { Pool, type PoolClient } from 'pg';
import { bodyOf, canonicalJson } from '../../src/core/hashchain';
import type { Checkpoint, Lang, Reading, SmsState } from '../../src/core/types';
import type { DeliveryState } from '../sms/beem';
import type { Role } from '../auth/auth';
import { LIMITS, type AppStore, type AuthCode, type InboundDraft, type Session, type Settings, type SmsDelivery, type SmsLogEntry, type SyncOutcome, type UnmatchedDlr, type User } from './types';

/**
 * Postgres store. Schema in server/db/migrations/*.sql, applied by migrate() on boot and in tests.
 * Plain Postgres, so the same code and schema run against Supabase by changing DATABASE_URL.
 *
 * A reading is written as the EXACT canonical JSON the client hashed (body_json, a text column) plus derived
 * typed columns for querying. Reads rebuild the record from body_json, never from the columns, so the hash the
 * lender verifies is byte-for-byte the one the phone produced. See the note at the top of 001_init.sql.
 */

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/** Rebuild a Reading from the stored canonical body plus its hash. */
const toReading = (row: { body_json: string; hash: string }): Reading => ({ ...(JSON.parse(row.body_json) as Omit<Reading, 'hash'>), hash: row.hash });

const toSms = (r: Record<string, unknown>): SmsLogEntry => {
  const e: SmsLogEntry = {
    id: r.id as string,
    at: iso(r.at),
    kind: r.kind as SmsLogEntry['kind'],
    state: r.state as SmsState,
    lang: r.lang as Lang,
    chars: Number(r.chars),
  };
  // Optional fields are left absent rather than set to null: the API shape must not change with the backend.
  if (r.alert_id != null) e.alertId = r.alert_id as string;
  if (r.error != null) e.error = r.error as string;
  if (r.beem_request_id != null) e.beemRequestId = r.beem_request_id as string;
  if (r.delivery_state != null) {
    e.delivery = { state: r.delivery_state as DeliveryState, raw: (r.delivery_raw ?? '') as string, at: iso(r.delivery_at), via: r.delivery_via as 'callback' | 'poll' };
  }
  return e;
};

const toCheckpoint = (r: Record<string, unknown>): Checkpoint => {
  const c: Checkpoint = {
    receivedAt: iso(r.received_at),
    farmId: r.farm_id as string,
    headHash: r.head_hash as string,
    headSeq: Number(r.head_seq),
    count: Number(r.count),
    chainOk: r.chain_ok as boolean,
  };
  if (r.broken_at_seq != null) c.brokenAtSeq = Number(r.broken_at_seq);
  return c;
};

const toUser = (r: Record<string, unknown>): User => {
  const u: User = {
    id: r.id as string,
    phone: r.phone as string,
    role: r.role as Role,
    createdAt: iso(r.created_at),
    disabled: r.disabled as boolean,
  };
  if (r.last_seen_at != null) u.lastSeenAt = iso(r.last_seen_at);
  if (r.consent_at != null) u.consentAt = iso(r.consent_at);
  if (r.consent_version != null) u.consentVersion = r.consent_version as string;
  return u;
};
const toCode = (r: Record<string, unknown>): AuthCode => {
  const c: AuthCode = {
    id: String(r.id),
    phone: r.phone as string,
    codeHash: r.code_hash as string,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    attempts: Number(r.attempts),
  };
  if (r.consumed_at != null) c.consumedAt = iso(r.consumed_at);
  return c;
};
const toSession = (r: Record<string, unknown>): Session => ({
  tokenHash: r.token_hash as string,
  userId: r.user_id as string,
  createdAt: iso(r.created_at),
  expiresAt: iso(r.expires_at),
  lastSeenAt: iso(r.last_seen_at),
});

export class PgStore implements AppStore {
  private pool: Pool;
  constructor(private connectionString: string, opts: { max?: number } = {}) {
    this.pool = new Pool({ connectionString, max: opts.max ?? 10 });
    // A pool error with no listener crashes the process. Swallow it: the next query reports the real failure.
    this.pool.on('error', () => { /* a broken idle connection is replaced by the pool */ });
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* connection already gone */ }
      throw e;
    } finally {
      c.release();
    }
  }

  /**
   * Apply any migrations this database has not seen, in order, each in its own transaction.
   * Safe to call on every boot and from several processes at once: an advisory lock serialises them,
   * and each migration is recorded so it runs exactly once. Returns the names actually applied.
   */
  async migrate(migrations: { name: string; sql: string }[]): Promise<string[]> {
    await this.pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied: string[] = [];
    const c = await this.pool.connect();
    try {
      // One migrator at a time, whatever else is booting.
      await c.query('SELECT pg_advisory_lock(hashtext($1))', ['ziwadata:migrate']);
      const done = new Set((await c.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
      for (const m of migrations) {
        if (done.has(m.name)) continue;
        await c.query('BEGIN');
        try {
          await c.query(m.sql);
          await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
          await c.query('COMMIT');
          applied.push(m.name);
        } catch (e) {
          await c.query('ROLLBACK');
          throw new Error(`migration ${m.name} failed: ${(e as Error).message}`);
        }
      }
    } finally {
      try { await c.query('SELECT pg_advisory_unlock(hashtext($1))', ['ziwadata:migrate']); } catch { /* connection gone */ }
      c.release();
    }
    return applied;
  }

  // ---- Users ----
  async findUserByPhone(phone: string): Promise<User | null> {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    return rows[0] ? toUser(rows[0]) : null;
  }
  async getUser(id: string): Promise<User | null> {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }
  async createUser(user: User): Promise<User> {
    // ON CONFLICT: two sign-ins racing on the same new number must not both insert.
    const { rows } = await this.pool.query(
      `INSERT INTO users (id, phone, role, created_at, disabled) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING *`,
      [user.id, user.phone, user.role, user.createdAt, user.disabled],
    );
    return toUser(rows[0]!);
  }
  async touchUser(id: string, atIso: string): Promise<void> {
    await this.pool.query('UPDATE users SET last_seen_at = $2 WHERE id = $1', [id, atIso]);
  }
  async setConsent(id: string, atIso: string, version: string): Promise<void> {
    await this.pool.query('UPDATE users SET consent_at = $2, consent_version = $3 WHERE id = $1', [id, atIso, version]);
  }

  // ---- One-time codes ----
  async putCode(code: AuthCode): Promise<void> {
    await this.tx(async (c) => {
      // The partial unique index allows only one live code per number, so retire the old one first.
      await c.query("UPDATE auth_codes SET consumed_at = $2 WHERE phone = $1 AND consumed_at IS NULL", [code.phone, code.createdAt]);
      await c.query(
        'INSERT INTO auth_codes (phone, code_hash, created_at, expires_at, attempts) VALUES ($1,$2,$3,$4,$5)',
        [code.phone, code.codeHash, code.createdAt, code.expiresAt, code.attempts],
      );
    });
  }
  async liveCode(phone: string, nowIso: string): Promise<AuthCode | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM auth_codes WHERE phone = $1 AND consumed_at IS NULL AND expires_at > $2 ORDER BY id DESC LIMIT 1',
      [phone, nowIso],
    );
    return rows[0] ? toCode(rows[0]) : null;
  }
  async countCodesSince(phone: string, sinceIso: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM auth_codes WHERE phone = $1 AND created_at >= $2', [phone, sinceIso]);
    return Number(rows[0]?.n ?? 0);
  }
  async lastCodeAt(phone: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ created_at: Date }>('SELECT created_at FROM auth_codes WHERE phone = $1 ORDER BY id DESC LIMIT 1', [phone]);
    return rows[0] ? iso(rows[0].created_at) : null;
  }
  async bumpCodeAttempts(id: string): Promise<number> {
    const { rows } = await this.pool.query<{ attempts: number }>('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts', [id]);
    return rows[0] ? Number(rows[0].attempts) : 0;
  }
  async consumeCode(id: string, atIso: string): Promise<void> {
    await this.pool.query('UPDATE auth_codes SET consumed_at = $2 WHERE id = $1', [id, atIso]);
  }

  // ---- Sessions ----
  async createSession(s: Session): Promise<void> {
    await this.pool.query(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES ($1,$2,$3,$4,$5)',
      [s.tokenHash, s.userId, s.createdAt, s.expiresAt, s.lastSeenAt],
    );
  }
  async findSession(tokenHash: string, nowIso: string): Promise<{ session: Session; user: User } | null> {
    const { rows } = await this.pool.query(
      `SELECT s.*, row_to_json(u.*) AS u FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > $2 AND NOT u.disabled`,
      [tokenHash, nowIso],
    );
    const r = rows[0];
    if (!r) return null;
    return { session: toSession(r), user: toUser(r.u as Record<string, unknown>) };
  }
  async touchSession(tokenHash: string, atIso: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET last_seen_at = $2 WHERE token_hash = $1', [tokenHash, atIso]);
  }
  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }
  async deleteExpiredSessions(nowIso: string): Promise<number> {
    const { rowCount } = await this.pool.query('DELETE FROM sessions WHERE expires_at <= $1', [nowIso]);
    return rowCount ?? 0;
  }

  // ---- Per-user settings ----
  async getUserSettings(userId: string): Promise<Settings> {
    const { rows } = await this.pool.query<{ phone: string | null; sms_lang: string }>('SELECT phone, sms_lang FROM user_settings WHERE user_id = $1', [userId]);
    const r = rows[0];
    if (!r) return {};
    const out: Settings = { smsLang: r.sms_lang as Settings['smsLang'] };
    if (r.phone != null) out.phone = r.phone;
    return out;
  }
  async putUserSettings(userId: string, patch: Settings & { clearPhone?: boolean }): Promise<Settings> {
    await this.pool.query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    if (patch.smsLang !== undefined) await this.pool.query('UPDATE user_settings SET sms_lang = $2 WHERE user_id = $1', [userId, patch.smsLang]);
    if (patch.clearPhone) await this.pool.query('UPDATE user_settings SET phone = NULL WHERE user_id = $1', [userId]);
    else if (patch.phone !== undefined) await this.pool.query('UPDATE user_settings SET phone = $2 WHERE user_id = $1', [userId, patch.phone]);
    return this.getUserSettings(userId);
  }

  // ---- Records ----
  async syncRecords(farmId: string, records: Reading[]): Promise<SyncOutcome> {
    return this.tx(async (c) => {
      // Serialise sync per farm, so two phones racing cannot both pass the "is this seq free?" check.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [farmId]);
      const existing = await c.query<{ id: string; seq: number }>('SELECT id, seq FROM readings WHERE farm_id = $1', [farmId]);
      const byId = new Set(existing.rows.map((r) => r.id));
      const bySeq = new Map(existing.rows.map((r) => [Number(r.seq), r.id]));

      let accepted = 0, duplicates = 0;
      const conflicts: string[] = [];
      for (const r of records) {
        if (byId.has(r.id)) { duplicates++; continue; }
        const held = bySeq.get(r.seq);
        if (held && held !== r.id) { conflicts.push(r.id); continue; }
        const isNum = typeof r.value === 'number';
        await c.query(
          `INSERT INTO readings (id, farm_id, seq, cage_id, kind, unit, ts, source, via, device_id, attested, demo,
                                 value_num, value_text, hash, prev_hash, body_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            r.id, farmId, r.seq, r.cageId, r.kind, r.unit, r.ts, r.source, r.via ?? null, r.deviceId ?? null,
            r.attested === true, r.demo,
            isNum ? (r.value as number) : null, isNum ? null : (r.value as string),
            r.hash, r.prevHash,
            // The exact bytes the client hashed.
            canonicalJson(bodyOf(r)),
          ],
        );
        byId.add(r.id); bySeq.set(r.seq, r.id); accepted++;
      }
      const all = await c.query<{ body_json: string; hash: string }>('SELECT body_json, hash FROM readings WHERE farm_id = $1 ORDER BY seq', [farmId]);
      return { accepted, duplicates, conflicts, list: all.rows.map(toReading) };
    });
  }

  async getRecords(farmId: string): Promise<Reading[]> {
    const { rows } = await this.pool.query<{ body_json: string; hash: string }>('SELECT body_json, hash FROM readings WHERE farm_id = $1 ORDER BY seq', [farmId]);
    return rows.map(toReading);
  }

  // ---- Checkpoints ----
  async latestCheckpoint(farmId: string): Promise<Checkpoint | null> {
    const { rows } = await this.pool.query('SELECT * FROM checkpoints WHERE farm_id = $1 ORDER BY id DESC LIMIT 1', [farmId]);
    return rows[0] ? toCheckpoint(rows[0]) : null;
  }
  async addCheckpoint(cp: Checkpoint): Promise<void> {
    await this.pool.query(
      'INSERT INTO checkpoints (received_at, farm_id, head_hash, head_seq, count, chain_ok, broken_at_seq) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [cp.receivedAt, cp.farmId, cp.headHash, cp.headSeq, cp.count, cp.chainOk, cp.brokenAtSeq ?? null],
    );
    // Keep the table bounded, the same as the JSON store.
    await this.pool.query('DELETE FROM checkpoints WHERE id <= (SELECT id FROM checkpoints ORDER BY id DESC OFFSET $1 LIMIT 1)', [LIMITS.checkpoints]);
  }
  async listCheckpoints(farmId: string | null, limit: number): Promise<Checkpoint[]> {
    const { rows } = farmId
      ? await this.pool.query('SELECT * FROM checkpoints WHERE farm_id = $1 ORDER BY id DESC LIMIT $2', [farmId, limit])
      : await this.pool.query('SELECT * FROM checkpoints ORDER BY id DESC LIMIT $1', [limit]);
    return rows.map(toCheckpoint);
  }

  // ---- Settings ----
  async getSettings(): Promise<Settings> {
    const { rows } = await this.pool.query<{ phone: string | null; sms_lang: Lang }>('SELECT phone, sms_lang FROM settings WHERE only_row');
    const r = rows[0];
    if (!r) return {};
    const out: Settings = { smsLang: r.sms_lang };
    if (r.phone != null) out.phone = r.phone;
    return out;
  }
  async putSettings(patch: Settings & { clearPhone?: boolean }): Promise<Settings> {
    if (patch.smsLang !== undefined) await this.pool.query('UPDATE settings SET sms_lang = $1 WHERE only_row', [patch.smsLang]);
    if (patch.clearPhone) await this.pool.query('UPDATE settings SET phone = NULL WHERE only_row');
    else if (patch.phone !== undefined) await this.pool.query('UPDATE settings SET phone = $1 WHERE only_row', [patch.phone]);
    return this.getSettings();
  }

  // ---- SMS ----
  async addSms(e: SmsLogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO sms_log (id, at, kind, state, lang, chars, alert_id, error, beem_request_id,
                            delivery_state, delivery_raw, delivery_at, delivery_via)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [e.id, e.at, e.kind, e.state, e.lang, e.chars, e.alertId ?? null, e.error ?? null, e.beemRequestId ?? null,
       e.delivery?.state ?? null, e.delivery?.raw ?? null, e.delivery?.at ?? null, e.delivery?.via ?? null],
    );
    await this.pool.query('DELETE FROM sms_log WHERE ins <= (SELECT ins FROM sms_log ORDER BY ins DESC OFFSET $1 LIMIT 1)', [LIMITS.smsLog]);
  }
  async getSms(id: string): Promise<SmsLogEntry | null> {
    const { rows } = await this.pool.query('SELECT * FROM sms_log WHERE id = $1', [id]);
    return rows[0] ? toSms(rows[0]) : null;
  }
  async listSms(limit: number): Promise<SmsLogEntry[]> {
    const { rows } = await this.pool.query('SELECT * FROM sms_log ORDER BY ins DESC LIMIT $1', [limit]);
    return rows.map(toSms);
  }
  async countSmsSince(sinceIso: string, states: SmsState[], kinds?: SmsLogEntry['kind'][]): Promise<number> {
    const { rows } = kinds
      ? await this.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sms_log WHERE at > $1 AND state = ANY($2) AND kind = ANY($3)', [sinceIso, states, kinds])
      : await this.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sms_log WHERE at > $1 AND state = ANY($2)', [sinceIso, states]);
    return Number(rows[0]?.n ?? 0);
  }
  async findSmsForDlr(dlrId: string): Promise<SmsLogEntry | null> {
    const { rows } = await this.pool.query('SELECT * FROM sms_log WHERE beem_request_id = $1 OR id = $1 ORDER BY ins DESC LIMIT 1', [dlrId]);
    return rows[0] ? toSms(rows[0]) : null;
  }
  async setSmsDelivery(id: string, d: SmsDelivery): Promise<void> {
    await this.pool.query('UPDATE sms_log SET delivery_state = $2, delivery_raw = $3, delivery_at = $4, delivery_via = $5 WHERE id = $1', [id, d.state, d.raw, d.at, d.via]);
  }
  async pendingDeliveries(limit: number): Promise<SmsLogEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM sms_log
        WHERE state = 'sent' AND beem_request_id IS NOT NULL AND (delivery_state IS NULL OR delivery_state = 'pending')
        ORDER BY ins DESC LIMIT $1`,
      [limit],
    );
    return rows.map(toSms).reverse(); // most recent `limit`, returned oldest first
  }

  // ---- Inbox ----
  async addInbox(items: InboundDraft[]): Promise<void> {
    if (!items.length) return;
    await this.tx(async (c) => {
      for (const i of items) await c.query('INSERT INTO inbox (id, received_at, draft) VALUES ($1,$2,$3)', [i.id, i.receivedAt, JSON.stringify(i.draft)]);
    });
  }
  async listInbox(): Promise<InboundDraft[]> {
    const { rows } = await this.pool.query<{ id: string; received_at: Date; draft: InboundDraft['draft'] }>('SELECT id, received_at, draft FROM inbox ORDER BY ins');
    return rows.map((r) => ({ id: r.id, receivedAt: iso(r.received_at), draft: r.draft }));
  }
  async ackInbox(ids: string[]): Promise<number> {
    if (ids.length) await this.pool.query('DELETE FROM inbox WHERE id = ANY($1)', [ids]);
    const { rows } = await this.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM inbox');
    return Number(rows[0]?.n ?? 0);
  }

  // ---- Unmatched delivery reports ----
  async addUnmatchedDlr(x: UnmatchedDlr): Promise<void> {
    await this.pool.query('INSERT INTO unmatched_dlr (at, dlr_id, raw) VALUES ($1,$2,$3)', [x.at, x.dlrId, x.raw]);
    await this.pool.query('DELETE FROM unmatched_dlr WHERE id <= (SELECT id FROM unmatched_dlr ORDER BY id DESC OFFSET $1 LIMIT 1)', [LIMITS.unmatchedDlr]);
  }
  async listUnmatchedDlr(): Promise<UnmatchedDlr[]> {
    const { rows } = await this.pool.query<{ at: Date; dlr_id: string | null; raw: string }>('SELECT at, dlr_id, raw FROM unmatched_dlr ORDER BY id');
    return rows.map((r) => ({ at: iso(r.at), dlrId: r.dlr_id, raw: r.raw }));
  }

  // ---- Admin ----
  async reset(): Promise<void> {
    // Demo data only. Settings, accounts and sessions survive: a demo reset must not sign everyone out.
    await this.pool.query('TRUNCATE readings, checkpoints, sms_log, inbox, unmatched_dlr');
  }
  async resetAll(): Promise<void> {
    // CASCADE because sessions and user_settings point at users.
    await this.pool.query('TRUNCATE readings, checkpoints, sms_log, inbox, unmatched_dlr, auth_codes, sessions, user_settings, users CASCADE');
    await this.pool.query("UPDATE settings SET phone = NULL, sms_lang = 'sw' WHERE only_row");
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
  describe(): string {
    // Never the password: strip the credentials out of the URL before showing it.
    try {
      const u = new URL(this.connectionString);
      return `Postgres (${u.host}${u.pathname})`;
    } catch {
      return 'Postgres';
    }
  }
}
