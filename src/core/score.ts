import { SCORE } from './config';
import { DAY_MS, dayKey, dayKeyToMs, startOfDay } from './format';
import { byTime } from './alerts';
import { isPlausible } from './rules';
import type { Cage, Reading } from './types';

/**
 * Record score, out of 100. Transparent rules, not a model: nothing here is "AI".
 * Completeness 40 + Consistency 20 + Verification 20 + Outcomes 20. Every part lists the readings behind it.
 * All weights and limits are demo defaults in SCORE (config.ts).
 */
export type PartId = 'completeness' | 'consistency' | 'verification' | 'outcomes';
export interface Gap {
  cageId: string;
  fromTs: string;
  toTs: string | null; // null = still open (no reading since fromTs)
  days: number;
}
export interface ScorePart {
  id: PartId;
  points: number;
  max: number;
  facts: Record<string, number>;
  evidence: {
    /** The readings that earn the points (completeness: first reading of each covered day). */
    primary: string[];
    /** The readings that cost points or do not count (implausible, self-reported, low DO...). */
    secondary: string[];
    /** Outcomes only: the mortality readings behind the "not rising" test. */
    extra?: string[];
    coveredDays?: string[];
    missingDays?: string[];
    gaps?: Gap[];
  };
}
export type AdviceKey = 'record_days' | 'fix_gaps' | 'implausible' | 'attest' | 'low_do' | 'mortality_rising' | 'record_mortality' | 'no_data' | 'keep_up';
export interface Advice {
  key: AdviceKey;
  params: Record<string, number | string>;
  gain: number;
}
export type HoldReason = 'score_low' | 'record_old' | 'no_readings';
export interface ScoreResult {
  total: number;
  parts: ScorePart[];
  lastReadingAt: string | null;
  daysSinceLast: number | null;
  holdsTranche: boolean;
  holdReasons: HoldReason[];
  advice: Advice[];
}

const MEASURE = new Set(['do', 'temp', 'ph', 'temp_deep', 'feed', 'mortality']);
const WATER = new Set(['do', 'temp', 'ph', 'temp_deep']);
export const isVerified = (r: Reading) => r.source === 'sensor' || r.attested === true;

const vpoints = (verified: number, total: number) => (total ? Math.round((SCORE.verificationMax * verified) / total) : 0);
const cpoints = (days: number) => Math.round((SCORE.completenessMax * days) / SCORE.windowDays);

export function computeScore(readings: Reading[], cages: Cage[], now: number): ScoreResult {
  const winStart = now - SCORE.windowDays * DAY_MS;
  const all = readings.filter((r) => MEASURE.has(r.kind) && Date.parse(r.ts) <= now).sort(byTime);
  const win = all.filter((r) => Date.parse(r.ts) > winStart);

  // ---- Completeness 40: days with at least one reading in the last 30 (East Africa calendar days) ----
  const today = dayKey(now);
  const windowDays: string[] = [];
  for (let i = SCORE.windowDays - 1; i >= 0; i--) windowDays.push(dayKey(dayKeyToMs(today) - i * DAY_MS));
  const firstOfDay = new Map<string, string>();
  for (const r of win) {
    const k = dayKey(Date.parse(r.ts));
    if (!firstOfDay.has(k)) firstOfDay.set(k, r.id);
  }
  const covered = windowDays.filter((d) => firstOfDay.has(d));
  const missing = windowDays.filter((d) => !firstOfDay.has(d));
  const completeness: ScorePart = {
    id: 'completeness', points: cpoints(covered.length), max: SCORE.completenessMax,
    facts: { days: covered.length, of: SCORE.windowDays },
    evidence: { primary: covered.map((d) => firstOfDay.get(d)!), secondary: [], coveredDays: covered, missingDays: missing },
  };

  // ---- Consistency 20: (10) no gap longer than 3 days on any active cage, (10) values inside plausible ranges ----
  const byCage = new Map<string, Reading[]>();
  for (const r of win) (byCage.get(r.cageId) ?? byCage.set(r.cageId, []).get(r.cageId)!).push(r);
  const gaps: Gap[] = [];
  for (const [cageId, rs] of byCage) {
    const ts = rs.map((r) => Date.parse(r.ts));
    for (let i = 0; i < ts.length - 1; i++) {
      const d = ts[i + 1]! - ts[i]!;
      if (d > SCORE.gapDays * DAY_MS) gaps.push({ cageId, fromTs: new Date(ts[i]!).toISOString(), toTs: new Date(ts[i + 1]!).toISOString(), days: Math.round((d / DAY_MS) * 10) / 10 });
    }
    const tail = now - ts[ts.length - 1]!;
    if (tail > SCORE.gapDays * DAY_MS) gaps.push({ cageId, fromTs: new Date(ts[ts.length - 1]!).toISOString(), toTs: null, days: Math.round((tail / DAY_MS) * 10) / 10 });
  }
  const activeCages = byCage.size;
  const gapCages = new Set(gaps.map((g) => g.cageId)).size;
  const gapPts = activeCages ? 10 * (1 - gapCages / activeCages) : 0;
  const implausible = win.filter((r) => !isPlausible(r.kind, r.value));
  const plausShare = win.length ? 1 - implausible.length / win.length : 0;
  const consistency: ScorePart = {
    id: 'consistency', points: Math.round(gapPts) + Math.round(10 * plausShare), max: SCORE.consistencyMax,
    facts: { cages: activeCages, gapCages, implausible: implausible.length, readings: win.length },
    evidence: { primary: [], secondary: implausible.map((r) => r.id), gaps },
  };

  // ---- Verification 20: share of water readings from a sensor OR an extension-officer attestation ----
  // Weather/satellite cross-checks earn nothing here: the Box weather route is not a water measurement.
  const water = win.filter((r) => WATER.has(r.kind));
  const verified = water.filter(isVerified);
  const selfReported = water.filter((r) => !isVerified(r));
  const verification: ScorePart = {
    id: 'verification', points: vpoints(verified.length, water.length), max: SCORE.verificationMax,
    facts: { verified: verified.length, total: water.length, attested: water.filter((r) => r.attested).length, sensor: water.filter((r) => r.source === 'sensor').length },
    evidence: { primary: verified.map((r) => r.id), secondary: selfReported.map((r) => r.id) },
  };

  // ---- Outcomes 20: (12) DO >= 5 mg/L on 90% of readings, (8) mortality not rising ----
  const doRs = win.filter((r) => r.kind === 'do' && typeof r.value === 'number');
  const doOk = doRs.filter((r) => (r.value as number) >= SCORE.doOkMg);
  const doShare = doRs.length ? doOk.length / doRs.length : null;
  const doPts = doShare === null ? 0 : Math.min(1, doShare / SCORE.doShareTarget) * SCORE.outcomesDoMax;
  const mort = win.filter((r) => r.kind === 'mortality' && typeof r.value === 'number');
  const split = now - 15 * DAY_MS;
  const last15 = mort.filter((r) => Date.parse(r.ts) > split).reduce((s, r) => s + (r.value as number), 0);
  const prev15 = mort.filter((r) => Date.parse(r.ts) <= split).reduce((s, r) => s + (r.value as number), 0);
  const rising = last15 > prev15 * SCORE.mortalityRiseRatio && last15 - prev15 >= SCORE.mortalityRiseMinAbs;
  const mortPts = mort.length === 0 ? 0 : rising ? 0 : SCORE.outcomesMortalityMax;
  const outcomes: ScorePart = {
    id: 'outcomes', points: Math.round(doPts) + mortPts, max: SCORE.outcomesMax,
    facts: { doReadings: doRs.length, doOk: doOk.length, doSharePct: doShare === null ? -1 : Math.round(doShare * 100), last15, prev15, rising: rising ? 1 : 0, mortalityReadings: mort.length, doPts: Math.round(doPts), mortPts },
    evidence: { primary: [], secondary: doRs.filter((r) => (r.value as number) < SCORE.doOkMg).map((r) => r.id), extra: mort.map((r) => r.id) },
  };

  const parts = [completeness, consistency, verification, outcomes];
  const total = parts.reduce((s, p) => s + p.points, 0);

  // ---- Tranche rule (simulated): below 60, or last reading older than 3 days ----
  const lastMs = all.length ? Date.parse(all[all.length - 1]!.ts) : null;
  const daysSinceLast = lastMs === null ? null : (now - lastMs) / DAY_MS;
  const holdReasons: HoldReason[] = [];
  if (lastMs === null) holdReasons.push('no_readings');
  if (total < SCORE.trancheMinScore) holdReasons.push('score_low');
  if (daysSinceLast !== null && daysSinceLast > SCORE.trancheMaxAgeDays) holdReasons.push('record_old');

  return {
    total, parts, lastReadingAt: lastMs === null ? null : new Date(lastMs).toISOString(), daysSinceLast,
    holdsTranche: holdReasons.length > 0, holdReasons,
    advice: buildAdvice({ total, parts, covered, gaps, implausible: implausible.length, verified: verified.length, waterTotal: water.length, doRs: doRs.length, doOk: doOk.length, rising, last15, prev15, mortReadings: mort.length, now, no: all.length === 0 }),
  };
}

interface AdviceCtx {
  total: number; parts: ScorePart[]; covered: string[]; gaps: Gap[]; implausible: number; verified: number; waterTotal: number;
  doRs: number; doOk: number; rising: boolean; last15: number; prev15: number; mortReadings: number; now: number; no: boolean;
}

function buildAdvice(c: AdviceCtx): Advice[] {
  const out: Advice[] = [];
  if (c.no) return [{ key: 'no_data', params: {}, gain: 0 }];
  const part = (id: PartId) => c.parts.find((p) => p.id === id)!;
  const target = Math.min(100, Math.floor(c.total / 10) * 10 + 10);

  // Record on N more days: project completeness if the farmer records on each of the next N days.
  const comp = part('completeness');
  if (comp.points < comp.max) {
    const coveredSet = new Set(c.covered);
    const todayMs = dayKeyToMs(dayKey(c.now));
    let best: { n: number; total: number } | null = null;
    for (let n = 1; n <= 14; n++) {
      const endMs = todayMs + (n - 1) * DAY_MS;
      const set = new Set(coveredSet);
      for (let i = 0; i < n; i++) set.add(dayKey(todayMs + i * DAY_MS));
      let count = 0;
      for (let i = 0; i < SCORE.windowDays; i++) if (set.has(dayKey(endMs - i * DAY_MS))) count++;
      const projected = c.total - comp.points + cpoints(count);
      best = { n, total: projected };
      if (projected >= target) break;
    }
    if (best && best.total > c.total) out.push({ key: 'record_days', params: { n: best.n, target: Math.min(target, best.total) }, gain: best.total - c.total });
  }

  const cons = part('consistency');
  if (c.gaps.length) {
    const g = [...c.gaps].sort((a, b) => b.days - a.days)[0]!;
    out.push({ key: 'fix_gaps', params: { cageId: g.cageId, days: Math.round(g.days), count: c.gaps.length }, gain: Math.max(1, Math.round(10 / Math.max(1, cons.facts.cages!))) });
  }
  if (c.implausible > 0) out.push({ key: 'implausible', params: { n: c.implausible }, gain: 1 });

  const ver = part('verification');
  if (ver.points < ver.max && c.waterTotal > 0) {
    for (let k = 1; k <= 10; k++) {
      const p = vpoints(c.verified + 2 * k, c.waterTotal + 2 * k);
      if (p >= ver.points + 2) {
        out.push({ key: 'attest', params: { n: k, points: p - ver.points }, gain: p - ver.points });
        break;
      }
    }
  } else if (ver.points < ver.max) {
    out.push({ key: 'attest', params: { n: 1, points: 2 }, gain: 2 });
  }

  const outc = part('outcomes');
  if (c.doRs > 0 && c.doOk / c.doRs < SCORE.doShareTarget) out.push({ key: 'low_do', params: { n: c.doRs - c.doOk }, gain: SCORE.outcomesDoMax - outc.facts.doPts! });
  if (c.mortReadings === 0) out.push({ key: 'record_mortality', params: {}, gain: SCORE.outcomesMortalityMax });
  else if (c.rising) out.push({ key: 'mortality_rising', params: { last: c.last15, prev: c.prev15 }, gain: SCORE.outcomesMortalityMax });

  out.sort((a, b) => b.gain - a.gain);
  if (!out.length) return [{ key: 'keep_up', params: {}, gain: 0 }];
  return out.slice(0, 4);
}

export { startOfDay };
