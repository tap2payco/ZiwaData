import { activeAlerts, byTime, replayAlerts } from '../core/alerts';
import { classifyDo, classifyPh, classifyTemp, evaluateTurnover, feedingLevel, worst, canResumeFeeding, type FeedLevel, type TurnoverResult } from '../core/rules';
import { daysLostToIncidents } from '../core/kpi';
import { computeScore, type ScoreResult } from '../core/score';
import type { Alert, Cage, Farm, Forecast, Reading, Status } from '../core/types';
import type { ChainResult } from '../core/hashchain';
import { HOUR_MS } from '../core/format';
import { RULES } from '../core/config';

export interface CageView {
  cage: Cage;
  status: Status;
  do: Reading | null;
  temp: Reading | null;
  ph: Reading | null;
  deep: Reading | null;
  lastAny: Reading | null;
  doSeries: number[];
  active: Alert[];
  stale: boolean;
  turnover: TurnoverResult;
  feeding: FeedLevel;
  canResume: boolean;
  readings: Reading[];
}
export interface FarmView {
  farm: Farm;
  readings: Reading[];
  alerts: Alert[];
  active: Alert[];
  cages: CageView[];
  score: ScoreResult;
  daysLost: { count: number; days: string[] };
  /** Cage with the lowest latest DO, or null when no cage has a DO reading. */
  lowest: CageView | null;
  needAttention: number;
  worstStatus: Status;
  chain: ChainResult | null;
  weatherStatus: Status;
}

export function buildFarmView(farm: Farm, all: Reading[], now: number, forecast: Forecast | null, chain: ChainResult | null): FarmView {
  const readings = all.filter((r) => r.farmId === farm.id && Date.parse(r.ts) <= now).sort(byTime);
  const alerts = replayAlerts(readings, farm.cages, now, forecast);
  const active = activeAlerts(alerts);
  const byCage = new Map<string, Reading[]>();
  for (const r of readings) (byCage.get(r.cageId) ?? byCage.set(r.cageId, []).get(r.cageId)!).push(r);

  const cages: CageView[] = farm.cages.map((cage) => {
    const rs = byCage.get(cage.id) ?? [];
    const last = (k: Reading['kind']) => { for (let i = rs.length - 1; i >= 0; i--) if (rs[i]!.kind === k) return rs[i]!; return null; };
    const d = last('do'), t = last('temp'), p = last('ph'), deep = last('temp_deep');
    const doSeries = rs.filter((r) => r.kind === 'do' && typeof r.value === 'number').map((r) => r.value as number);
    const cageActive = active.filter((a) => a.cageId === cage.id);
    const measured = rs.filter((r) => r.kind === 'do' || r.kind === 'temp');
    const lastMeasured = measured.length ? Date.parse(measured[measured.length - 1]!.ts) : null;
    const stale = cage.sensor && lastMeasured !== null && now - lastMeasured > RULES.stale.hours * HOUR_MS;
    const turnover = cage.depthProbe
      ? evaluateTurnover({ surface: t && typeof t.value === 'number' ? t.value : null, deep: deep && typeof deep.value === 'number' ? deep.value : null, doSeries })
      : ({ status: 'none', reason: 'no_probe' } as TurnoverResult);
    const known = [classifyDo(d ? (d.value as number) : null), classifyTemp(t ? (t.value as number) : null), classifyPh(p ? (p.value as number) : null)];
    const status = worst(...known, ...(stale ? (['watch'] as Status[]) : []), ...cageActive.map((a) => a.severity as Status));
    const feeding = feedingLevel({ doStatus: classifyDo(d ? (d.value as number) : null), turnoverStatus: turnover.status });
    return { cage, status, do: d, temp: t, ph: p, deep, lastAny: rs.length ? rs[rs.length - 1]! : null, doSeries, active: cageActive, stale, turnover, feeding, canResume: canResumeFeeding(doSeries), readings: rs };
  });

  const withDo = cages.filter((c) => c.do);
  const lowest = withDo.length ? withDo.reduce((a, b) => ((a.do!.value as number) <= (b.do!.value as number) ? a : b)) : null;
  const weatherStatus = worst(...active.filter((a) => a.cageId === null).map((a) => a.severity as Status), ...([] as Status[]));
  return {
    farm, readings, alerts, active, cages, score: computeScore(readings, farm.cages, now), daysLost: daysLostToIncidents(alerts, readings, now),
    lowest, needAttention: cages.filter((c) => c.status === 'watch' || c.status === 'critical').length,
    worstStatus: worst(...cages.map((c) => c.status)), chain, weatherStatus,
  };
}

/** Readings behind a score part, looked up by id. */
export const indexById = (rs: Reading[]) => new Map(rs.map((r) => [r.id, r]));
