import { describe, expect, it } from 'vitest';
import { computeScore } from '../src/core/score';
import { verifyChain } from '../src/core/hashchain';
import { DEMO_TAMPERED_FARM_ID, TAMPER_SEQ, generateWorld } from '../src/core/seed';
import { buildChain } from '../src/core/hashchain';
import { DAY_MS } from '../src/core/format';
import type { Cage, Reading, ReadingDraft } from '../src/core/types';
import { getWorld, NOW } from './helpers';

const cages: Cage[] = [{ id: 'c1', farmId: 'f', number: 1, sensor: false, depthProbe: false }];
const d = (daysAgo: number, kind: ReadingDraft['kind'], value: number, extra: Partial<ReadingDraft> = {}): ReadingDraft => ({
  cageId: 'c1', farmId: 'f', kind, value, unit: '', ts: new Date(NOW - daysAgo * DAY_MS).toISOString(), source: 'manual', via: 'app', demo: true, ...extra,
});
const chain = (ds: ReadingDraft[]) => buildChain(ds.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)));

describe('score parts', () => {
  it('completeness: days with a reading in the last 30, scaled to 40', async () => {
    const rs = await chain([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((i) => d(i, 'do', 6)));
    const s = computeScore(rs, cages, NOW);
    expect(s.parts[0]).toMatchObject({ id: 'completeness', points: 20, facts: { days: 15, of: 30 } });
    expect(s.parts[0]!.evidence.missingDays).toHaveLength(15);
    expect(s.parts[0]!.evidence.primary).toHaveLength(15);
  });
  it('consistency: a gap over 3 days on a cage costs points; implausible values cost points', async () => {
    const good = await chain([0, 1, 2, 3].map((i) => d(i, 'do', 6)));
    expect(computeScore(good, cages, NOW).parts[1]).toMatchObject({ points: 20 });
    const gap = await chain([d(0, 'do', 6), d(5, 'do', 6)]);
    const sg = computeScore(gap, cages, NOW).parts[1]!;
    expect(sg.evidence.gaps).toHaveLength(1);
    expect(sg.points).toBe(10);
    const bad = await chain([d(0, 'do', 6), d(1, 'do', 25), d(2, 'do', 6), d(3, 'do', 6)]);
    const sb = computeScore(bad, cages, NOW).parts[1]!;
    expect(sb.evidence.secondary).toHaveLength(1);
    expect(sb.points).toBe(18);
  });
  it('verification counts sensor and attested readings only; weather/satellite earns nothing', async () => {
    const rs = await chain([
      d(0, 'do', 6, { source: 'sensor' }), d(1, 'do', 6, { source: 'sensor' }),
      d(2, 'do', 6, { via: 'attestation', attested: true }), d(3, 'do', 6), d(4, 'do', 6, { source: 'satellite' }),
    ]);
    const v = computeScore(rs, cages, NOW).parts[2]!;
    expect(v.facts).toMatchObject({ verified: 3, total: 5, attested: 1, sensor: 2 });
    expect(v.points).toBe(12);
    expect(v.evidence.secondary).toHaveLength(2);
  });
  it('outcomes: DO >= 5 on 90% of readings, and mortality not rising', async () => {
    const steady = await chain([
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => d(i, 'do', 6)),
      d(20, 'mortality', 3), d(2, 'mortality', 3),
    ]);
    expect(computeScore(steady, cages, NOW).parts[3]).toMatchObject({ points: 20 });
    const lowDo = await chain([...[0, 1, 2, 3, 4].map((i) => d(i, 'do', 6)), ...[5, 6, 7, 8, 9].map((i) => d(i, 'do', 4.5)), d(20, 'mortality', 3), d(2, 'mortality', 3)]);
    expect(computeScore(lowDo, cages, NOW).parts[3]!.facts.doPts).toBe(7); // 50% share vs 90% target => 12 * 0.5/0.9
    const rising = await chain([d(0, 'do', 6), d(20, 'mortality', 2), d(3, 'mortality', 20)]);
    const p = computeScore(rising, cages, NOW).parts[3]!;
    expect(p.facts.rising).toBe(1);
    expect(p.points).toBe(12);
  });
  it('no readings scores 0 and holds the tranche; unknown is never 100', () => {
    const s = computeScore([], cages, NOW);
    expect(s.total).toBe(0);
    expect(s.holdReasons).toContain('no_readings');
    expect(s.advice[0]!.key).toBe('no_data');
  });
});

describe('tranche rule', () => {
  it('holds below 60 or when the last reading is older than 3 days', async () => {
    const old = await chain([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => d(i + 4, 'do', 6, { source: 'sensor' })));
    const s = computeScore(old, cages, NOW);
    expect(s.holdReasons).toContain('record_old');
    expect(s.daysSinceLast).toBeGreaterThan(3);
    const fresh = await chain([d(0, 'do', 6)]);
    expect(computeScore(fresh, cages, NOW).holdReasons).toContain('score_low');
  });
});

describe('advice is specific', () => {
  it('projects how many days of recording reach the next 10 points', async () => {
    const rs = await chain(Array.from({ length: 20 }, (_, i) => d(i, 'do', 6, { source: 'sensor' })));
    const s = computeScore(rs, cages, NOW);
    const a = s.advice.find((x) => x.key === 'record_days');
    expect(a).toBeTruthy();
    const target = a!.params.target as number;
    expect(target).toBeGreaterThan(s.total);
    // Verify the promise: recording on each of the next n days reaches the target.
    const more = await chain([...Array.from({ length: 20 }, (_, i) => d(i, 'do', 6, { source: 'sensor' })), ...Array.from({ length: a!.params.n as number }, (_, i) => d(-(i + 1), 'do', 6, { source: 'sensor' }))]);
    const later = NOW + (a!.params.n as number) * DAY_MS;
    expect(computeScore(more, cages, later).parts[0]!.points).toBeGreaterThanOrEqual(s.parts[0]!.points);
  });
});

describe('demo world', () => {
  it('is deterministic', async () => {
    const a = await generateWorld(NOW);
    const b = await getWorld();
    expect(a.readings.length).toBe(b.readings.length);
    expect(a.readings.at(-1)!.hash).toBe(b.readings.at(-1)!.hash);
  });
  it('every chain is intact except Salma, which breaks at the edited entry', async () => {
    const w = await getWorld();
    for (const f of w.farms) {
      const res = await verifyChain(w.readings.filter((r) => r.farmId === f.id));
      if (f.id === DEMO_TAMPERED_FARM_ID) expect(res).toMatchObject({ ok: false, brokenAtSeq: TAMPER_SEQ });
      else expect(res.ok).toBe(true);
    }
  });
  it('borrowers differ in quality and everything is labelled demo', async () => {
    const w = await getWorld();
    expect(w.farms).toHaveLength(5);
    const scores = w.farms.map((f) => computeScore(w.readings.filter((r) => r.farmId === f.id), f.cages, NOW));
    expect(new Set(scores.map((s) => s.total)).size).toBe(5);
    expect(Math.max(...scores.map((s) => s.total))).toBeGreaterThan(90);
    expect(scores.some((s) => s.holdReasons.includes('score_low'))).toBe(true);
    expect(scores.some((s) => s.holdReasons.includes('record_old'))).toBe(true);
    expect(w.readings.every((r: Reading) => r.demo)).toBe(true);
    const demo = w.farms.find((f) => f.id === 'farm-demo')!;
    expect(demo.cages).toHaveLength(6);
  });
  it('demo farm: 4 sensor cages, a 4-day gap on cage 2, one cage with no readings', async () => {
    const w = await getWorld();
    const rs = w.readings.filter((r) => r.farmId === 'farm-demo');
    expect(rs.some((r) => r.cageId === 'farm-demo-c6')).toBe(false);
    const sensorCages = new Set(rs.filter((r) => r.source === 'sensor').map((r) => r.cageId));
    expect(sensorCages.size).toBe(4);
    const s = computeScore(rs, w.farms[0]!.cages, NOW);
    expect(s.parts[1]!.evidence.gaps!.some((g) => g.cageId === 'farm-demo-c2' && g.days >= 4)).toBe(true);
    expect(s.holdsTranche).toBe(false);
  });
});
