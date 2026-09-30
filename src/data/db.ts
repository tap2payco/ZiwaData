import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Reading, SmsState } from '../core/types';

export interface OutboxItem {
  id: string; // "rd:<readingId>" or "sms:<requestId>"
  type: 'reading' | 'sms';
  farmId?: string;
  readingId?: string;
  sms?: { kind: 'test' | 'alert'; lang: 'sw' | 'en'; template?: string; params?: Record<string, number | boolean>; requestId: string; alertId?: string };
  createdAt: string;
  attempts: number;
  lastError?: string;
}
export interface AlertSms {
  alertId: string;
  state: SmsState;
  requestId: string;
  at: string;
  error?: string;
}
export interface LenderAction {
  id?: number;
  farmId: string;
  action: 'hold' | 'release';
  reason: string;
  ts: string;
}
interface Schema extends DBSchema {
  readings: { key: string; value: Reading; indexes: { byFarm: string; byFarmSeq: [string, number] } };
  outbox: { key: string; value: OutboxItem };
  meta: { key: string; value: unknown };
  alertSms: { key: string; value: AlertSms };
  lenderActions: { key: number; value: LenderAction; indexes: { byFarm: string } };
}
export type Db = IDBPDatabase<Schema>;

export async function openAppDb(name = 'fish-early-warning-demo'): Promise<Db> {
  return openDB<Schema>(name, 1, {
    upgrade(db) {
      const r = db.createObjectStore('readings', { keyPath: 'id' });
      r.createIndex('byFarm', 'farmId');
      r.createIndex('byFarmSeq', ['farmId', 'seq']);
      db.createObjectStore('outbox', { keyPath: 'id' });
      db.createObjectStore('meta');
      db.createObjectStore('alertSms', { keyPath: 'alertId' });
      const l = db.createObjectStore('lenderActions', { keyPath: 'id', autoIncrement: true });
      l.createIndex('byFarm', 'farmId');
    },
  });
}

export const getMeta = async <T>(db: Db, key: string): Promise<T | undefined> => (await db.get('meta', key)) as T | undefined;
export const setMeta = (db: Db, key: string, value: unknown) => db.put('meta', value, key);

export async function bulkPutReadings(db: Db, rs: Reading[]) {
  for (let i = 0; i < rs.length; i += 500) {
    const tx = db.transaction('readings', 'readwrite');
    for (const r of rs.slice(i, i + 500)) void tx.store.put(r);
    await tx.done;
  }
}
export const allReadings = (db: Db) => db.getAll('readings');
export async function lastReading(db: Db, farmId: string): Promise<Reading | null> {
  const cur = await db.transaction('readings').store.index('byFarmSeq').openCursor(IDBKeyRange.bound([farmId, 0], [farmId, Number.MAX_SAFE_INTEGER]), 'prev');
  return cur ? cur.value : null;
}
export async function clearAll(db: Db) {
  const tx = db.transaction(['readings', 'outbox', 'meta', 'alertSms', 'lenderActions'], 'readwrite');
  await Promise.all([tx.objectStore('readings').clear(), tx.objectStore('outbox').clear(), tx.objectStore('meta').clear(), tx.objectStore('alertSms').clear(), tx.objectStore('lenderActions').clear(), tx.done]);
}
