import { ZERO_HASH } from './config';
import { sha256HexSync } from './sha256';
import type { Reading, ReadingBody, ReadingDraft } from './types';

/**
 * Tamper-evidence, first step. Each record's hash covers the previous hash plus the record's own content, so editing
 * an old record breaks every hash after it. LIMIT: a client-side chain shows edits, but whoever owns the device can
 * rebuild the whole chain. Real tamper-evidence needs the server (or a third party) to record the chain head over
 * time: see POST /api/sync and GET /api/checkpoints. Even that is not an independent anchor yet.
 */

/** Canonical JSON: keys sorted, undefined dropped, no whitespace. Same input, same bytes, everywhere. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export async function sha256Hex(input: string): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) return sha256HexSync(input);
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function bodyOf(r: Reading | ReadingBody): ReadingBody {
  const { hash: _hash, ...body } = r as Reading;
  return body;
}

export async function hashBody(body: ReadingBody): Promise<string> {
  return sha256Hex(body.prevHash + canonicalJson(body));
}

export function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  const bytes = new Uint8Array(8);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Append one draft to a chain whose current head is `prev` (or null for genesis). */
export async function appendToChain(draft: ReadingDraft, prev: Reading | null, id?: string): Promise<Reading> {
  const seq = prev ? prev.seq + 1 : 1;
  const body: ReadingBody = {
    ...draft,
    id: draft.id ?? id ?? `${draft.farmId}-${newId()}`,
    seq,
    prevHash: prev ? prev.hash : ZERO_HASH,
  };
  return { ...body, hash: await hashBody(body) };
}

/** Build a whole chain from ordered drafts (used by the seed). */
export async function buildChain(drafts: ReadingDraft[], startAfter: Reading | null = null): Promise<Reading[]> {
  const out: Reading[] = [];
  let prev = startAfter;
  for (const d of drafts) {
    const r = await appendToChain(d, prev, d.id ?? `${d.farmId}-r${(prev ? prev.seq : 0) + 1}`);
    out.push(r);
    prev = r;
  }
  return out;
}

export interface ChainResult {
  ok: boolean;
  brokenAtSeq?: number;
  count: number;
  headHash: string;
  reason?: 'hash_mismatch' | 'link_mismatch' | 'seq_gap';
}

/** Verify one farm's chain. Returns the first seq where something does not add up. */
export async function verifyChain(records: Reading[]): Promise<ChainResult> {
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  let prevHash = ZERO_HASH;
  let expectedSeq = 1;
  for (const r of sorted) {
    if (r.seq !== expectedSeq) return { ok: false, brokenAtSeq: expectedSeq, count: sorted.length, headHash: prevHash, reason: 'seq_gap' };
    if (r.prevHash !== prevHash) return { ok: false, brokenAtSeq: r.seq, count: sorted.length, headHash: prevHash, reason: 'link_mismatch' };
    const h = await hashBody(bodyOf(r));
    if (h !== r.hash) return { ok: false, brokenAtSeq: r.seq, count: sorted.length, headHash: prevHash, reason: 'hash_mismatch' };
    prevHash = r.hash;
    expectedSeq++;
  }
  return { ok: true, count: sorted.length, headHash: prevHash };
}
