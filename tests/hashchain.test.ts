import { describe, expect, it } from 'vitest';
import { appendToChain, buildChain, canonicalJson, sha256Hex, verifyChain } from '../src/core/hashchain';
import { sha256HexSync } from '../src/core/sha256';
import { ZERO_HASH } from '../src/core/config';
import type { ReadingDraft } from '../src/core/types';

const draft = (i: number): ReadingDraft => ({ cageId: 'c1', farmId: 'f1', kind: 'do', value: 5 + i / 10, unit: 'mg/L', ts: new Date(Date.UTC(2026, 8, 1, i)).toISOString(), source: 'manual', via: 'app', demo: true });

describe('canonicalJson', () => {
  it('sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }], e: undefined })).toBe('{"a":[2,{"c":3}],"b":1}');
  });
});

describe('sha256', () => {
  it('pure-JS fallback matches WebCrypto', async () => {
    for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'Kizimba °C — test', 'x'.repeat(1000)]) {
      expect(sha256HexSync(s)).toBe(await sha256Hex(s));
    }
    expect(sha256HexSync('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('hash chain', () => {
  it('starts at 64 zeros and links each record to the previous hash', async () => {
    const chain = await buildChain([draft(0), draft(1), draft(2)]);
    expect(chain[0]!.prevHash).toBe(ZERO_HASH);
    expect(chain[1]!.prevHash).toBe(chain[0]!.hash);
    expect(chain.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(await verifyChain(chain)).toMatchObject({ ok: true, count: 3, headHash: chain[2]!.hash });
  });
  it('hash = SHA-256(prevHash + canonical JSON of the record without hash)', async () => {
    const [r] = await buildChain([draft(0)]);
    const { hash, ...body } = r!;
    expect(hash).toBe(await sha256Hex(ZERO_HASH + canonicalJson(body)));
  });
  it('detects an edited value at the exact entry', async () => {
    const chain = await buildChain(Array.from({ length: 10 }, (_, i) => draft(i)));
    const bad = chain.map((r) => (r.seq === 4 ? { ...r, value: 9.9 } : r));
    expect(await verifyChain(bad)).toMatchObject({ ok: false, brokenAtSeq: 4, reason: 'hash_mismatch' });
  });
  it('detects a removed record', async () => {
    const chain = await buildChain(Array.from({ length: 6 }, (_, i) => draft(i)));
    const bad = chain.filter((r) => r.seq !== 3);
    expect(await verifyChain(bad)).toMatchObject({ ok: false, brokenAtSeq: 3 });
  });
  it('detects an edit whose own hash was recomputed, at the next entry', async () => {
    const chain = await buildChain(Array.from({ length: 6 }, (_, i) => draft(i)));
    const edited = await appendToChain({ ...draft(2), value: 1.1 }, chain[1]!, chain[2]!.id);
    const bad = chain.map((r) => (r.seq === 3 ? edited : r));
    expect(await verifyChain(bad)).toMatchObject({ ok: false, brokenAtSeq: 4, reason: 'link_mismatch' });
  });
  it('an empty chain is intact', async () => {
    expect(await verifyChain([])).toMatchObject({ ok: true, count: 0, headHash: ZERO_HASH });
  });
});
