/**
 * Beem SMS client. Ported from the owner's existing client (ref/beem-reference.ts) with these changes:
 * no logging of phone numbers, request bodies or credentials; env-driven config; injectable fetch for tests;
 * timeouts; dry-run when credentials are missing.
 * Env: BEEM_API_KEY, BEEM_SECRET_KEY (alias BEEM_API_SECRET), BEEM_SENDER_ID.
 *
 * Checked against Beem's published documentation on 2026-09-30 (docs.beem.africa):
 *   POST https://apisms.beem.africa/v1/send                      HTTP Basic (key:secret). CONFIRMED.
 *     Body: source_addr (<= 11 chars), message, encoding, recipients[{recipient_id, dest_addr}],
 *           optional schedule_time "yyyy-mm-dd hh:mm" GMT+0. CONFIRMED.
 *   GET  https://apisms.beem.africa/public/v1/vendors/balance     Basic. Returns { data: { credit_balance } }. CONFIRMED.
 *   GET  https://dlrapi.beem.africa/public/v1/delivery-reports    Basic. ?dest_addr=&request_id=
 *     Returns [{ dest_addr, status: DELIVERED|PENDING|UNDELIVERED, request_id }]. CONFIRMED.
 *     Beem says to check no sooner than 5 minutes after sending.
 *   Callback: Beem POSTs inbound messages AND delivery reports to a callback URL you register with them.
 *     See parseDlrCallback below for what is documented and what is not.
 *
 * Known difference from the docs, left alone on purpose: the docs type `recipient_id` as an integer, and both this
 * client and the owner's production client send it as a string. The production client works, so Beem accepts a string.
 *
 * STILL NOT VERIFIED LIVE from this build: no credentials were available, so no request has ever left this machine.
 */
export interface BeemEnv {
  BEEM_API_KEY?: string;
  BEEM_SECRET_KEY?: string;
  BEEM_API_SECRET?: string;
  BEEM_SENDER_ID?: string;
}
export interface BeemOptions {
  env: BeemEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}
export interface SendSMSParams {
  to: string | string[];
  message: string;
  scheduledTime?: string;
}
export interface SendResult {
  success: boolean;
  /** True when no credentials are configured: nothing was sent. */
  dryRun?: boolean;
  requestId?: string | number;
  error?: string;
  code?: number;
}

export const BEEM_SEND_URL = 'https://apisms.beem.africa/v1/send';
export const BEEM_BALANCE_URL = 'https://apisms.beem.africa/public/v1/vendors/balance';
export const BEEM_DLR_URL = 'https://dlrapi.beem.africa/public/v1/delivery-reports';
/** Beem's approved sender IDs are alphanumeric and at most 11 characters (docs, send-sms). */
export const BEEM_SENDER_MAX = 11;

/**
 * Beem response codes, from the published table (docs.beem.africa/guides/sms/api-responses).
 * 100 is success. 103 is the ONE server-side error worth retrying. Everything else in this range is a
 * permanent failure: retrying it just burns the hourly cap without ever succeeding.
 * The previous list here (101, 102, 105, 111, 120) came from the reference client and was wrong:
 * 105 is not a documented code, and 104 and 109-123 are permanent but were being retried.
 */
export const BEEM_CODES: Record<number, string> = {
  100: 'submitted',
  101: 'invalid_destination',
  102: 'insufficient_balance',
  103: 'beem_server_error',
  104: 'missing_parameters',
  109: 'invalid_message',
  110: 'unsupported_characters',
  111: 'invalid_sender_id',
  112: 'schedule_in_past',
  113: 'invalid_request_format',
  114: 'too_many_recipients',
  115: 'missing_destination',
  116: 'invalid_reference_id',
  117: 'invalid_schedule_format',
  118: 'missing_encoding',
  119: 'missing_recipients',
  120: 'invalid_credentials',
  121: 'invalid_sender_id_format',
  122: 'duplicate_sender_id',
  123: 'template_not_found',
};
/** The only documented Beem code that a retry can fix. */
export const BEEM_RETRYABLE_CODES = [103];

/**
 * True when this failure can never succeed on a retry.
 * `code` is either a Beem response code (100-199) or, when the body carried none, an HTTP status.
 */
export function isPermanentFailure(code: number | undefined): boolean {
  if (code === undefined) return false; // network error or unreadable body: worth one more try
  if (code >= 100 && code < 200) return !BEEM_RETRYABLE_CODES.includes(code);
  if (code >= 400 && code < 500) return code !== 408 && code !== 429; // timeout and rate-limit are worth retrying
  return false;
}

/** Why a configured sender ID would be rejected by Beem, or null when it looks sendable. Never returns the value. */
export function senderIdIssue(sender: string | undefined): 'missing' | 'too_long' | 'not_alphanumeric' | null {
  const v = (sender ?? '').trim();
  if (!v) return 'missing';
  if (v.length > BEEM_SENDER_MAX) return 'too_long';
  if (!/^[A-Za-z0-9 ]+$/.test(v)) return 'not_alphanumeric';
  return null;
}

export function beemCredentials(env: BeemEnv): { key: string; secret: string } | null {
  const key = env.BEEM_API_KEY?.trim();
  const secret = (env.BEEM_SECRET_KEY || env.BEEM_API_SECRET)?.trim();
  return key && secret ? { key, secret } : null;
}
export const beemConfigured = (env: BeemEnv) => beemCredentials(env) !== null;

/** Normalise Tanzanian numbers to 255XXXXXXXXX. 0712345678 and 712345678 both become 255712345678. */
export function normalizeRecipient(phone: string): string {
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('0') && p.length === 10) p = '255' + p.slice(1);
  else if (p.length === 9) p = '255' + p;
  return p;
}

const basic = (c: { key: string; secret: string }) => 'Basic ' + Buffer.from(`${c.key}:${c.secret}`).toString('base64');

async function timedFetch(f: typeof fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await f(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** One send attempt. Never logs recipients, message text, request body or credentials. */
export async function sendSMS(params: SendSMSParams, opts: BeemOptions): Promise<SendResult> {
  const creds = beemCredentials(opts.env);
  if (!creds) return { success: false, dryRun: true, error: 'not_configured' };
  const sender = (opts.env.BEEM_SENDER_ID || '').trim();
  if (!sender) return { success: false, error: 'sender_id_missing' };
  const f = opts.fetchImpl ?? fetch;
  try {
    const recipients = (Array.isArray(params.to) ? params.to : [params.to]).map((phone, i) => ({ recipient_id: String(i + 1), dest_addr: normalizeRecipient(phone) }));
    const res = await timedFetch(
      f,
      BEEM_SEND_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basic(creds) },
        body: JSON.stringify({ source_addr: sender, schedule_time: params.scheduledTime ?? '', encoding: 0, message: params.message, recipients }),
      },
      opts.timeoutMs ?? 15000,
    );
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const ok = body && (body.successful === true || body.code === 100 || (typeof body.data?.message === 'string' && body.data.message.includes('submitted')));
    if (ok) return { success: true, requestId: body.request_id };
    const code = typeof body?.code === 'number' ? body.code : !res.ok ? res.status : undefined;
    // Prefer the documented code name over Beem's free-text message, so the log stays a fixed vocabulary.
    const error = (code !== undefined && BEEM_CODES[code]) || `http_${res.status}`;
    return { success: false, error, code };
  } catch (e: any) {
    return { success: false, error: e?.name === 'AbortError' ? 'timeout' : 'network_error' };
  }
}

/** Retries up to 3 times with exponential backoff (1 s, 2 s), never on a permanent failure (see isPermanentFailure). */
export async function sendSMSWithRetry(
  params: SendSMSParams,
  opts: BeemOptions & { maxRetries?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<SendResult> {
  const max = opts.maxRetries ?? 3;
  const base = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: SendResult = { success: false, error: 'failed' };
  for (let attempt = 1; attempt <= max; attempt++) {
    last = await sendSMS(params, opts);
    if (last.success || last.dryRun) return last;
    if (last.error === 'sender_id_missing') return last;
    if (isPermanentFailure(last.code)) return last;
    if (attempt < max) await sleep(base * 2 ** (attempt - 1));
  }
  return { ...last, error: last.error ?? 'failed_after_retries' };
}

export interface BalanceResult {
  success: boolean;
  balance?: number | string;
  error?: string;
  /** Set when Beem answered at all. Lets the caller tell "unreachable" apart from "credentials rejected". */
  httpStatus?: number;
  /** True when a response came back from Beem, whatever it said. */
  reachable?: boolean;
}
export async function checkBalance(opts: BeemOptions): Promise<BalanceResult> {
  const creds = beemCredentials(opts.env);
  if (!creds) return { success: false, error: 'not_configured', reachable: false };
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await timedFetch(f, BEEM_BALANCE_URL, { method: 'GET', headers: { 'Content-Type': 'application/json', Authorization: basic(creds) } }, opts.timeoutMs ?? 15000);
    const body: any = await res.json().catch(() => null);
    if (body?.data) return { success: true, balance: body.data.credit_balance, httpStatus: res.status, reachable: true };
    const code = typeof body?.code === 'number' ? body.code : undefined;
    const error = (code !== undefined && BEEM_CODES[code]) || (res.status === 401 || res.status === 403 ? 'credentials_rejected' : 'balance_unavailable');
    return { success: false, error, httpStatus: res.status, reachable: true };
  } catch (e: any) {
    return { success: false, error: e?.name === 'AbortError' ? 'timeout' : 'network_error', reachable: false };
  }
}

// ---------------------------------------------------------------------------------------------
// Delivery reports. Two routes, both from the docs (checked 2026-09-30).
// ---------------------------------------------------------------------------------------------

/** What this app records. Beem's own vocabulary is richer; `raw` keeps exactly what Beem said. */
export type DeliveryState = 'pending' | 'delivered' | 'failed' | 'unknown';
export interface DeliveryReport {
  state: DeliveryState;
  /** Beem's own word or code, kept verbatim so nothing is lost in translation. */
  raw: string;
}

/**
 * DLR callback STATUS codes, from the documented table (api-reference/receive-inbound-message-or-dlr).
 * 9 "Orphaned" and 11 "Unknown" are deliberately NOT called a failure: Beem does not say the message failed,
 * only that it cannot report on it, and telling a farmer "failed" when Beem did not say so would be inventing.
 */
export const DLR_STATUS: Record<number, { word: string; state: DeliveryState }> = {
  1: { word: 'Delivered', state: 'delivered' },
  2: { word: 'In process', state: 'pending' },
  3: { word: 'Failed', state: 'failed' },
  4: { word: 'Deleted', state: 'failed' },
  5: { word: 'Expired', state: 'failed' },
  6: { word: 'Rejected', state: 'failed' },
  7: { word: 'Canceled', state: 'failed' },
  8: { word: 'Queued', state: 'pending' },
  9: { word: 'Orphaned', state: 'unknown' },
  10: { word: 'Relayed', state: 'pending' },
  11: { word: 'Unknown', state: 'unknown' },
};

/** The polling API's three words. */
export const DLR_POLL_STATUS: Record<string, DeliveryState> = {
  DELIVERED: 'delivered',
  PENDING: 'pending',
  UNDELIVERED: 'failed',
};

/** Beem asks callers to wait at least 5 minutes after sending before polling for a report. */
export const DLR_MIN_POLL_DELAY_MS = 5 * 60_000;

export interface DlrPollResult {
  success: boolean;
  report?: DeliveryReport;
  error?: string;
  httpStatus?: number;
}
/**
 * Poll the documented delivery-report API for one message.
 * GET https://dlrapi.beem.africa/public/v1/delivery-reports?dest_addr=&request_id=
 * Never logs the number: it goes into the query string of the outbound call and nowhere else.
 */
export async function getDeliveryReport(
  params: { destAddr: string; requestId: string },
  opts: BeemOptions,
): Promise<DlrPollResult> {
  const creds = beemCredentials(opts.env);
  if (!creds) return { success: false, error: 'not_configured' };
  const f = opts.fetchImpl ?? fetch;
  const q = new URLSearchParams({ dest_addr: normalizeRecipient(params.destAddr), request_id: params.requestId });
  try {
    const res = await timedFetch(f, `${BEEM_DLR_URL}?${q}`, { method: 'GET', headers: { 'Content-Type': 'application/json', Authorization: basic(creds) } }, opts.timeoutMs ?? 15000);
    if (res.status === 404) return { success: false, error: 'report_not_found', httpStatus: 404 };
    const body: any = await res.json().catch(() => null);
    const row = Array.isArray(body) ? body[0] : body?.data ?? body;
    const word = typeof row?.status === 'string' ? row.status.trim().toUpperCase() : null;
    if (!word) return { success: false, error: 'no_status_in_response', httpStatus: res.status };
    // An undocumented word is reported as unknown, never guessed into delivered or failed.
    return { success: true, report: { state: DLR_POLL_STATUS[word] ?? 'unknown', raw: word }, httpStatus: res.status };
  } catch (e: any) {
    return { success: false, error: e?.name === 'AbortError' ? 'timeout' : 'network_error' };
  }
}

export interface DlrCallback {
  /** The send request this report belongs to. Beem calls it DLRID. */
  dlrId: string | null;
  report: DeliveryReport;
}
/**
 * Parse a delivery report that Beem POSTed to our callback URL.
 *
 * Documented shape (api-reference/receive-inbound-message-or-dlr): application/x-www-form-urlencoded with
 * uppercase fields; a DLR is the one carrying DLRID and STATUS (1-11). Express gives us those as an object
 * either way, so this takes the already-parsed body and is agnostic about form vs JSON encoding.
 *
 * NOT VERIFIED: no callback has ever been received by this build, and Beem's own docs describe two different
 * callback shapes (this uppercase form one, and a lowercase JSON one for Two-Way SMS inbound). Anything this
 * cannot read is reported as unparsed and is never turned into a delivery state.
 */
export function parseDlrCallback(body: unknown): DlrCallback | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  // Case-insensitive lookup: the docs use uppercase, but we have not seen a real callback.
  const pick = (...names: string[]): unknown => {
    const want = new Set(names.map((n) => n.toLowerCase()));
    for (const [k, v] of Object.entries(b)) if (want.has(k.toLowerCase())) return v;
    return undefined;
  };
  const statusRaw = pick('STATUS', 'status');
  const dlrRaw = pick('DLRID', 'dlr_id', 'dlrId', 'request_id', 'requestId');
  if (statusRaw === undefined) return null; // not a delivery report
  const dlrId = dlrRaw === undefined || dlrRaw === null || dlrRaw === '' ? null : String(dlrRaw);
  const n = typeof statusRaw === 'number' ? statusRaw : Number(String(statusRaw).trim());
  if (Number.isFinite(n) && DLR_STATUS[n]) return { dlrId, report: { state: DLR_STATUS[n]!.state, raw: `${n} ${DLR_STATUS[n]!.word}` } };
  // Some responses use the polling API's words instead of a number.
  const word = String(statusRaw).trim().toUpperCase();
  if (DLR_POLL_STATUS[word]) return { dlrId, report: { state: DLR_POLL_STATUS[word]!, raw: word } };
  return { dlrId, report: { state: 'unknown', raw: String(statusRaw).slice(0, 40) } };
}
