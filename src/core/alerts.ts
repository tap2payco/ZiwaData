import { RULES } from './config';
import { HOUR_MS } from './format';
import { classifyDo, classifyPh, classifyTemp, classifyWeather, evaluateTurnover } from './rules';
import type { Alert, AlertParams, Cage, Forecast, Reading, RuleId, Status } from './types';

type Cfg = typeof RULES;

const KIND_ORDER: Record<string, number> = { do: 0, temp: 1, temp_deep: 2, ph: 3, feed: 4, mortality: 5, incident: 6 };
export const byTime = (a: Reading, b: Reading) => Date.parse(a.ts) - Date.parse(b.ts) || a.seq - b.seq || (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);

const alertId = (farmId: string, cageId: string | null, rule: RuleId, firstFiredAt: string) => `${farmId}:${cageId ?? 'farm'}:${rule}:${firstFiredAt}`;

/**
 * Rebuild the alert history for one farm by replaying its readings in time order.
 * Dedupe: ONE alert per cage+rule until it clears. It records `firstFiredAt`, and `clearedAt` when the rule is OK again.
 * Pure: same readings and clock, same alerts.
 */
export function replayAlerts(readings: Reading[], cages: Cage[], now: number, forecast: Forecast | null = null, cfg: Cfg = RULES): Alert[] {
  const out: Alert[] = [];
  const farmId = cages[0]?.farmId ?? readings[0]?.farmId ?? '';

  for (const cage of cages) {
    const rs = readings.filter((r) => r.cageId === cage.id && Date.parse(r.ts) <= now).sort(byTime);
    const open = new Map<RuleId, Alert>();
    const doSeries: number[] = [];
    let temp: number | undefined;
    let deep: number | undefined;

    const apply = (rule: RuleId, status: Status, ts: string, params: AlertParams) => {
      const cur = open.get(rule);
      if (status === 'watch' || status === 'critical') {
        if (!cur) {
          const a: Alert = { id: alertId(farmId, cage.id, rule, ts), farmId, cageId: cage.id, rule, severity: status, peak: status, firstFiredAt: ts, active: true, params };
          open.set(rule, a);
          out.push(a);
        } else {
          cur.severity = status;
          if (status === 'critical') cur.peak = 'critical';
          cur.params = params;
        }
      } else if (status === 'ok' && cur) {
        cur.active = false;
        cur.clearedAt = ts;
        open.delete(rule);
      }
    };
    // Turnover is judged when a deep reading arrives, using the latest surface temperature and the last 3 DO readings.
    // (Judging at every reading would compare values from different moments and flap.)
    const turnover = (ts: string) => {
      if (!cage.depthProbe) return;
      const t = evaluateTurnover({ surface: temp, deep, doSeries }, cfg);
      if (t.status === 'none') return;
      apply('turnover', t.status, ts, { deltaC: t.deltaC, doDrop: t.doDrop, value: t.latestDo });
    };

    for (const r of rs) {
      if (typeof r.value !== 'number') continue;
      if (r.kind === 'do') {
        doSeries.push(r.value);
        const s = classifyDo(r.value, cfg);
        apply('do', s, r.ts, { value: r.value, threshold: s === 'critical' ? cfg.do.criticalBelow : cfg.do.okMin });
      } else if (r.kind === 'temp') {
        temp = r.value;
        const s = classifyTemp(r.value, cfg);
        const low = r.value < cfg.temp.okMin;
        const thr = s === 'critical' ? (low ? cfg.temp.watchMin : cfg.temp.watchMax) : low ? cfg.temp.okMin : cfg.temp.okMax;
        apply('temp', s, r.ts, { value: r.value, threshold: thr, limitKind: low ? 'low' : 'high' });
      } else if (r.kind === 'temp_deep') {
        deep = r.value;
        turnover(r.ts);
      } else if (r.kind === 'ph') {
        const s = classifyPh(r.value, cfg);
        const low = r.value < cfg.ph.okMin;
        const thr = s === 'critical' ? (low ? cfg.ph.watchMin : cfg.ph.watchMax) : low ? cfg.ph.okMin : cfg.ph.okMax;
        apply('ph', s, r.ts, { value: r.value, threshold: thr, limitKind: low ? 'low' : 'high' });
      }
    }

    // Stale: sensor cages only. Any DO/temperature reading resets the clock. Never treated as OK.
    if (cage.sensor) {
      const ts = rs.filter((r) => r.kind === 'do' || r.kind === 'temp').map((r) => Date.parse(r.ts));
      const limit = cfg.stale.hours * HOUR_MS;
      for (let i = 0; i < ts.length - 1; i++) {
        const gap = ts[i + 1]! - ts[i]!;
        if (gap > limit) {
          const fired = new Date(ts[i]! + limit).toISOString();
          out.push({
            id: alertId(farmId, cage.id, 'stale', fired), farmId, cageId: cage.id, rule: 'stale', severity: 'watch', peak: 'watch',
            firstFiredAt: fired, clearedAt: new Date(ts[i + 1]!).toISOString(), active: false, params: { hours: Math.round(gap / HOUR_MS) },
          });
        }
      }
      const last = ts.length ? ts[ts.length - 1]! : null;
      if (last !== null && now - last > limit) {
        const fired = new Date(last + limit).toISOString();
        out.push({
          id: alertId(farmId, cage.id, 'stale', fired), farmId, cageId: cage.id, rule: 'stale', severity: 'watch', peak: 'watch',
          firstFiredAt: fired, active: true, params: { hours: Math.round((now - last) / HOUR_MS) },
        });
      }
    }
  }

  if (forecast) {
    const w = classifyWeather(forecast, cfg);
    if (w.wind === 'watch' || w.wind === 'critical') {
      out.push({ id: alertId(farmId, null, 'wind', forecast.issuedAt), farmId, cageId: null, rule: 'wind', severity: w.wind, peak: w.wind, firstFiredAt: forecast.issuedAt, active: true, params: { value: forecast.windKmh ?? undefined, threshold: w.wind === 'critical' ? cfg.weather.windCriticalKmh : cfg.weather.windWatchKmh }, unverified: forecast.unverified });
    }
    if (w.rain === 'watch') {
      out.push({ id: alertId(farmId, null, 'rain', forecast.issuedAt), farmId, cageId: null, rule: 'rain', severity: 'watch', peak: 'watch', firstFiredAt: forecast.issuedAt, active: true, params: { value: forecast.rainMm ?? undefined, threshold: cfg.weather.rainWatchMm }, unverified: forecast.unverified });
    }
  }
  return out.sort((a, b) => Date.parse(b.firstFiredAt) - Date.parse(a.firstFiredAt));
}

export const activeAlerts = (alerts: Alert[]) => alerts.filter((a) => a.active);

/** Latest reading of a kind on a cage (by time). */
export function latestOf(readings: Reading[], cageId: string, kind: Reading['kind'], now = Infinity): Reading | null {
  let best: Reading | null = null;
  let bt = -Infinity;
  for (const r of readings) {
    if (r.cageId !== cageId || r.kind !== kind) continue;
    const t = Date.parse(r.ts);
    if (t > now) continue;
    if (t > bt || (t === bt && best && r.seq > best.seq)) {
      best = r;
      bt = t;
    }
  }
  return best;
}
