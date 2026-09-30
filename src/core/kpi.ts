import { DAY_MS, dayKey, dayKeyToMs } from './format';
import type { Alert, Reading } from './types';

/**
 * Headline KPI (wording to be confirmed): days in the last 30 on which a cage had a Critical alert
 * or an incident (predator, poaching, storm, disease, other) was logged. Fewer is better; the target is zero.
 */
export function daysLostToIncidents(alerts: Alert[], readings: Reading[], now: number, windowDays = 30): { count: number; days: string[] } {
  const start = dayKeyToMs(dayKey(now)) - (windowDays - 1) * DAY_MS;
  const days = new Set<string>();
  const add = (ms: number) => {
    if (ms >= start && ms <= now) days.add(dayKey(ms));
  };
  for (const r of readings) if (r.kind === 'incident') add(Date.parse(r.ts));
  for (const a of alerts) {
    if (a.peak !== 'critical' || a.rule === 'stale') continue;
    const from = Date.parse(a.firstFiredAt);
    const to = a.clearedAt ? Date.parse(a.clearedAt) : now;
    for (let d = dayKeyToMs(dayKey(Math.max(from, start))); d <= to; d += DAY_MS) add(d);
  }
  return { count: days.size, days: [...days].sort() };
}
