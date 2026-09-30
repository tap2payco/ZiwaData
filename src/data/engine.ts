import { appendToChain, verifyChain, type ChainResult } from '../core/hashchain';
import { DEMO_POINT } from '../core/config';
import { generateWorld } from '../core/seed';
import { templateForAlert, paramsForAlert } from '../core/sms-templates';
import type { Alert, Checkpoint, Farm, Forecast, Lang, Reading, ReadingDraft, SmsState } from '../core/types';
import { ApiError, type Api, type ServerSettings, type SmsDelivery } from './api';
import { allReadings, bulkPutReadings, clearAll, getMeta, lastReading, setMeta, type AlertSms, type Db, type LenderAction, type OutboxItem } from './db';

export interface ClientSettings {
  /** Which alert types are also sent by SMS. In-app alerts always show. */
  smsAlertTypes: { do: boolean; temp: boolean; ph: boolean; turnover: boolean; weather: boolean; stale: boolean };
  smsLang: Lang;
}
export const DEFAULT_SETTINGS: ClientSettings = { smsAlertTypes: { do: true, temp: true, ph: true, turnover: true, weather: true, stale: true }, smsLang: 'sw' };

export interface SyncSummary {
  status: 'ok' | 'offline' | 'unreachable' | 'busy';
  sentReadings: number;
  sentSms: number;
  pulledInbound: number;
  /** Readings the server refused because another device already wrote that place in the farm's chain. They stay in the outbox. */
  conflicts?: number;
  at?: string;
  error?: string;
}
export interface ChainSync {
  checkpoint: Checkpoint | null;
  chain: { ok: boolean; brokenAtSeq?: number; count: number };
}
export interface Snapshot {
  farms: Farm[];
  readings: Reading[];
  alertSms: Record<string, AlertSms>;
  lenderActions: LenderAction[];
  pending: { readings: number; sms: number };
  settings: ClientSettings;
  lastSyncAt: string | null;
  chainSync: Record<string, ChainSync>;
  forecast: { forecast: Forecast; mode: 'demo' | 'live'; fetchedAt: string } | null;
  serverSettings: ServerSettings | null;
  lastTestSms: { state: SmsState; at: string; error?: string; requestId: string } | null;
  /**
   * What Beem reported about each sent message, keyed by our own requestId. Only ever filled from the server's
   * SMS log. A requestId that is missing here has NO report yet, which is not the same as delivered.
   */
  smsDelivery: Record<string, SmsDelivery>;
  seededAt: number;
}

export interface EngineDeps {
  db: Db;
  api: Api;
  now: () => number;
  isOnline: () => boolean;
}

/**
 * Offline-first data engine: everything is written to IndexedDB first ("Saved on this phone"), queued in the outbox,
 * and sent when there is signal. Sync is idempotent by record id.
 */
export class Engine {
  private lock: Promise<unknown> = Promise.resolve();
  private syncing: Promise<SyncSummary> | null = null;
  constructor(private d: EngineDeps) {}

  /** Serialise writers so two saves can never claim the same sequence number. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  async init(): Promise<void> {
    const seeded = await getMeta<number>(this.d.db, 'seededAt');
    if (seeded === undefined) await this.seed();
  }
  private async seed() {
    const t = this.d.now();
    const w = await generateWorld(t);
    await bulkPutReadings(this.d.db, w.readings);
    await setMeta(this.d.db, 'farms', w.farms);
    await setMeta(this.d.db, 'seededAt', t);
  }
  /** Reset demo data: wipes this phone's data and reseeds. The server reset is a separate call made by the caller. */
  async resetDemo() {
    await clearAll(this.d.db);
    await this.seed();
  }

  async snapshot(): Promise<Snapshot> {
    const db = this.d.db;
    const readings = await allReadings(db);
    const alertSms: Record<string, AlertSms> = {};
    for (const a of await db.getAll('alertSms')) alertSms[a.alertId] = a;
    const outbox = await db.getAll('outbox');
    return {
      farms: (await getMeta<Farm[]>(db, 'farms')) ?? [],
      readings,
      alertSms,
      lenderActions: await db.getAll('lenderActions'),
      pending: { readings: outbox.filter((o) => o.type === 'reading').length, sms: outbox.filter((o) => o.type === 'sms').length },
      settings: { ...DEFAULT_SETTINGS, ...((await getMeta<ClientSettings>(db, 'settings')) ?? {}) },
      lastSyncAt: (await getMeta<string>(db, 'lastSyncAt')) ?? null,
      chainSync: (await getMeta<Record<string, ChainSync>>(db, 'chainSync')) ?? {},
      forecast: (await getMeta<Snapshot['forecast']>(db, 'forecast')) ?? null,
      smsDelivery: (await getMeta<Record<string, SmsDelivery>>(db, 'smsDelivery')) ?? {},
      serverSettings: (await getMeta<ServerSettings>(db, 'serverSettings')) ?? null,
      lastTestSms: (await getMeta<Snapshot['lastTestSms']>(db, 'lastTestSms')) ?? null,
      seededAt: (await getMeta<number>(db, 'seededAt')) ?? 0,
    };
  }

  async saveSettings(s: ClientSettings) {
    await setMeta(this.d.db, 'settings', s);
  }

  /**
   * Append readings to a farm's hash chain, save them on this phone and put them in the outbox. One call = one save,
   * so a whole form (DO + temp + pH + feed + dead fish + incident) is written together.
   */
  record(farmId: string, drafts: ReadingDraft[], opts: { idFor?: (i: number) => string | undefined } = {}): Promise<Reading[]> {
    return this.exclusive(async () => {
      const db = this.d.db;
      const out: Reading[] = [];
      let prev = await lastReading(db, farmId);
      for (let i = 0; i < drafts.length; i++) {
        const draft = drafts[i]!;
        const wantId = opts.idFor?.(i);
        if (wantId && (await db.get('readings', wantId))) continue; // idempotent by id
        const rec = await appendToChain({ ...draft, farmId, id: wantId }, prev);
        const tx = db.transaction(['readings', 'outbox'], 'readwrite');
        void tx.objectStore('readings').put(rec);
        void tx.objectStore('outbox').put({ id: 'rd:' + rec.id, type: 'reading', farmId, readingId: rec.id, createdAt: new Date(this.d.now()).toISOString(), attempts: 0 } satisfies OutboxItem);
        await tx.done;
        out.push(rec);
        prev = rec;
      }
      return out;
    });
  }

  async queueSms(item: NonNullable<OutboxItem['sms']>): Promise<void> {
    const db = this.d.db;
    const tx = db.transaction(['outbox', 'alertSms'], 'readwrite');
    void tx.objectStore('outbox').put({ id: 'sms:' + item.requestId, type: 'sms', sms: item, createdAt: new Date(this.d.now()).toISOString(), attempts: 0 });
    if (item.alertId) void tx.objectStore('alertSms').put({ alertId: item.alertId, state: 'queued', requestId: item.requestId, at: new Date(this.d.now()).toISOString() });
    await tx.done;
  }

  /** Queue the SMS for an alert (skipped when its type is switched off). Returns true when queued. */
  async queueAlertSms(alert: Alert, cageNumber: number | undefined, settings: ClientSettings): Promise<boolean> {
    const type = alert.rule === 'wind' || alert.rule === 'rain' ? 'weather' : alert.rule;
    if (!settings.smsAlertTypes[type]) return false;
    const p = paramsForAlert(alert, cageNumber);
    const params: Record<string, number | boolean> = {};
    for (const [k, v] of Object.entries(p)) if (typeof v === 'number' || typeof v === 'boolean') params[k] = v;
    await this.queueSms({ kind: 'alert', lang: settings.smsLang, template: templateForAlert(alert), params, requestId: `sms-${alert.id}-${alert.severity}`, alertId: alert.id });
    return true;
  }

  async addLenderAction(a: Omit<LenderAction, 'id'>) {
    await this.d.db.add('lenderActions', a);
  }

  /** Send everything pending. Safe to call repeatedly: the server dedupes by record id and SMS request id. */
  sync(opts: { refresh?: boolean } = {}): Promise<SyncSummary> {
    if (this.syncing) return this.syncing;
    const run = this.doSync(opts).finally(() => { this.syncing = null; });
    this.syncing = run;
    return run;
  }

  private async doSync(opts: { refresh?: boolean }): Promise<SyncSummary> {
    const { db, api } = this.d;
    if (!this.d.isOnline()) return { status: 'offline', sentReadings: 0, sentSms: 0, pulledInbound: 0 };
    const sum: SyncSummary = { status: 'ok', sentReadings: 0, sentSms: 0, pulledInbound: 0 };
    try {
      // 1. Inbound SMS drafts (simulated) join the local chain, then are acknowledged.
      const inbox = await api.inbox();
      if (inbox.items.length) {
        for (const item of inbox.items) await this.record(item.draft.farmId, [item.draft], { idFor: () => item.id });
        await api.ackInbox(inbox.items.map((i) => i.id));
        sum.pulledInbound = inbox.items.length;
      }

      // 2. Readings. First sync of a farm sends its whole chain; afterwards only what is pending.
      const farms = (await getMeta<Farm[]>(db, 'farms')) ?? [];
      const boot = (await getMeta<Record<string, boolean>>(db, 'bootstrapped')) ?? {};
      const chainSync = (await getMeta<Record<string, ChainSync>>(db, 'chainSync')) ?? {};
      const outbox = await db.getAll('outbox');
      for (const farm of farms) {
        const pendingIds = new Set(outbox.filter((o) => o.type === 'reading' && o.farmId === farm.id).map((o) => o.readingId!));
        if (boot[farm.id] && pendingIds.size === 0) continue;
        const all = (await db.getAllFromIndex('readings', 'byFarm', farm.id)).sort((a, b) => a.seq - b.seq);
        const toSend = boot[farm.id] ? all.filter((r) => pendingIds.has(r.id)) : all;
        let resp = null as Awaited<ReturnType<Api['sync']>> | null;
        const refused = new Set<string>();
        for (let i = 0; i < toSend.length; i += 1000) {
          resp = await api.sync(farm.id, toSend.slice(i, i + 1000));
          sum.sentReadings += toSend.slice(i, i + 1000).length;
          for (const id of resp.conflicts ?? []) refused.add(id);
        }
        if (refused.size) sum.conflicts = (sum.conflicts ?? 0) + refused.size;
        if (resp) {
          chainSync[farm.id] = { checkpoint: resp.checkpoint, chain: { ok: resp.chain.ok, brokenAtSeq: resp.chain.brokenAtSeq, count: resp.chain.count } };
          boot[farm.id] = true;
          const tx = db.transaction('outbox', 'readwrite');
          for (const id of pendingIds) if (!refused.has(id)) void tx.store.delete('rd:' + id); // refused readings stay queued, never dropped silently
          await tx.done;
        }
      }
      await setMeta(db, 'bootstrapped', boot);
      await setMeta(db, 'chainSync', chainSync);

      // 3. SMS requests
      for (const item of (await db.getAll('outbox')).filter((o) => o.type === 'sms')) {
        const s = item.sms!;
        let state: SmsState | null = null;
        let error: string | undefined;
        try {
          const r = await api.sendSms({ kind: s.kind, lang: s.lang, template: s.template, params: s.params, requestId: s.requestId, alertId: s.alertId });
          state = r.state === 'queued' ? 'queued' : r.state;
          error = r.error;
        } catch (e) {
          if (e instanceof ApiError && !e.offline && e.status >= 400 && e.status < 500) {
            state = 'failed'; // no_phone, rate_limited, bad request: retrying will not help
            error = e.code;
          } else throw e; // offline or server trouble: keep it queued
        }
        if (state && state !== 'queued') {
          const tx = db.transaction(['outbox', 'alertSms', 'meta'], 'readwrite');
          void tx.objectStore('outbox').delete(item.id);
          if (s.alertId) void tx.objectStore('alertSms').put({ alertId: s.alertId, state, requestId: s.requestId, at: new Date(this.d.now()).toISOString(), error });
          else void tx.objectStore('meta').put({ state, at: new Date(this.d.now()).toISOString(), error, requestId: s.requestId }, 'lastTestSms');
          await tx.done;
        }
        sum.sentSms++;
      }

      // 4. Refresh what the server knows (best effort; failures here do not fail the sync)
      if (opts.refresh !== false) {
        try { await setMeta(db, 'serverSettings', await api.settings()); } catch { /* keep old */ }
        try {
          const w = await api.weather(DEMO_POINT.lat, DEMO_POINT.lon);
          await setMeta(db, 'forecast', { forecast: w.forecast, mode: w.mode, fetchedAt: new Date(this.d.now()).toISOString() });
        } catch { /* keep old */ }
        // Delivery reports, when the server offers them. Only entries Beem has actually reported on are kept.
        if (api.smsLog) {
          try {
            const { log } = await api.smsLog();
            const delivery: Record<string, SmsDelivery> = {};
            for (const e of log) if (e.delivery) delivery[e.id] = e.delivery;
            await setMeta(db, 'smsDelivery', delivery);
          } catch { /* keep old */ }
        }
      }
      sum.at = new Date(this.d.now()).toISOString();
      await setMeta(db, 'lastSyncAt', sum.at);
      return sum;
    } catch (e) {
      if (e instanceof ApiError) return { ...sum, status: e.offline ? (e.code === 'offline' ? 'offline' : 'unreachable') : 'unreachable', error: e.code };
      throw e;
    }
  }

  async verify(farmId: string): Promise<ChainResult> {
    const rs = await this.d.db.getAllFromIndex('readings', 'byFarm', farmId);
    return verifyChain(rs);
  }
}
