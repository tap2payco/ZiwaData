import type { Checkpoint, Forecast, Reading, ReadingDraft } from '../core/types';
import { isOnline } from './net';

/** Browser to server calls. The server holds all secrets (Beem, Box); the browser never sees them. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, public offline = false) {
    super(code);
  }
}
export const API_BASE: string = (import.meta.env?.VITE_API_BASE as string | undefined) ?? '';

export interface SyncResponse {
  accepted: number;
  duplicates: number;
  conflicts: string[];
  chain: { ok: boolean; brokenAtSeq?: number; count: number; headHash: string };
  checkpoint: Checkpoint | null;
}
export interface SmsSendBody {
  kind: 'test' | 'alert';
  lang: 'sw' | 'en';
  template?: string;
  params?: Record<string, number | boolean>;
  requestId: string;
  alertId?: string;
}
export interface SmsSendResponse {
  state: 'sent' | 'failed' | 'dry_run' | 'queued';
  requestId: string;
  dryRun?: boolean;
  message?: string;
  error?: string;
  duplicate?: boolean;
}
export interface ServerSettings {
  hasPhone: boolean;
  phoneMasked: string | null;
  smsLang: 'sw' | 'en';
  sms: { mode: 'dry-run' | 'configured' };
}
export interface InboxItem {
  id: string;
  receivedAt: string;
  draft: ReadingDraft;
}
export interface InboundResult {
  ok: boolean;
  simulated: boolean;
  error?: string;
  field?: string;
  reply: string;
  queued?: number;
}
export interface BoxRouteStatus {
  id: string; method: string; path: string; auth: string[]; used: boolean; configured: boolean; mode: 'demo' | 'live';
  lastTest: { at: string; ok: boolean; httpStatus?: number; error?: string } | null;
}
export interface BoxStatus { baseUrl: string; keyConfigured: boolean; bearerConfigured: boolean; routes: BoxRouteStatus[] }
export interface WeatherResponse { mode: 'demo' | 'live'; forecast: Forecast; liveError?: string; raw?: { wind: number | null; windUnit: string | null; rain: number | null; rainUnit: string | null; temp: number | null } }
export interface DevicesResponse {
  mode: 'demo' | 'live';
  assumedShape: boolean;
  liveError?: string;
  mapped: { devices: { id: string; name: string; type: string; lastSeen: string | null }[]; readings: ReadingDraft[]; weather: { deviceId: string; windKmh: number | null; rainMm: number | null; tempC: number | null }[]; skipped: number };
}
export interface SmsStatus { mode: 'dry-run' | 'configured'; senderIdSet: boolean; live: boolean; lastOkAt: string | null; maxPerHour: number }
/** What Beem later said about one message. Absent means no report has arrived, which is NOT "delivered". */
export type DeliveryState = 'pending' | 'delivered' | 'failed' | 'unknown';
export interface SmsDelivery { state: DeliveryState; raw: string; at: string; via: 'callback' | 'poll' }
export interface SmsLogEntry { id: string; at: string; kind: string; state: string; lang: string; chars: number; alertId?: string; error?: string; beemRequestId?: string; delivery?: SmsDelivery }
export interface SmsHealth {
  configured: boolean;
  senderIdSet: boolean;
  senderIdIssue: 'missing' | 'too_long' | 'not_alphanumeric' | null;
  mode: 'dry-run' | 'configured';
  live: boolean;
  lastOkAt: string | null;
  maxPerHour: number;
  checkedAt: string;
  /** null when nothing was called because no credentials are set. */
  reachable: boolean | null;
  balance: number | string | null;
  httpStatus?: number;
  error?: string;
}

/** The calls the engine needs. Tests supply a fake. */
export interface Api {
  sync(farmId: string, records: Reading[]): Promise<SyncResponse>;
  sendSms(body: SmsSendBody): Promise<SmsSendResponse>;
  inbox(): Promise<{ items: InboxItem[] }>;
  ackInbox(ids: string[]): Promise<void>;
  weather(lat: number, lon: number): Promise<WeatherResponse>;
  settings(): Promise<ServerSettings>;
  /** Optional: delivery reports are a live-Beem feature, so fakes and older servers may not offer it. */
  smsLog?(): Promise<{ log: SmsLogEntry[] }>;
}

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 12000): Promise<T> {
  if (!isOnline()) throw new ApiError(0, 'offline', true);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE + path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) throw new ApiError(res.status, json?.error ?? `http_${res.status}`);
    if (json === null) throw new ApiError(res.status, 'bad_response'); // e.g. an HTML page from a host with no API
    return json as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, 'unreachable', true);
  } finally {
    clearTimeout(t);
  }
}

export const http = {
  get: <T,>(p: string) => call<T>('GET', p),
  post: <T,>(p: string, b?: unknown) => call<T>('POST', p, b ?? {}),
  put: <T,>(p: string, b: unknown) => call<T>('PUT', p, b),
};

export const httpApi: Api = {
  sync: (farmId, records) => http.post<SyncResponse>('/api/sync', { farmId, records }),
  sendSms: (body) => http.post<SmsSendResponse>('/api/sms/send', body),
  inbox: () => http.get('/api/inbox'),
  ackInbox: async (ids) => void (await http.post('/api/inbox/ack', { ids })),
  weather: (lat, lon) => http.get(`/api/box/weather?lat=${lat}&lon=${lon}`),
  settings: () => http.get('/api/settings'),
  smsLog: () => http.get('/api/sms/log'),
};
