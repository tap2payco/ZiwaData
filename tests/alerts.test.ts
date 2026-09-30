import { describe, expect, it } from 'vitest';
import { replayAlerts } from '../src/core/alerts';
import { demoForecast } from '../src/core/forecast';
import { daysLostToIncidents } from '../src/core/kpi';
import { DEMO_FARM_ID } from '../src/core/seed';
import { buildChain } from '../src/core/hashchain';
import type { Cage, ReadingDraft } from '../src/core/types';
import { getWorld, NOW } from './helpers';

const cage: Cage = { id: 'c1', farmId: 'f', number: 1, sensor: true, depthProbe: false };
const mk = (h: number, kind: ReadingDraft['kind'], value: number): ReadingDraft => ({ cageId: 'c1', farmId: 'f', kind, value, unit: '', ts: new Date(Date.UTC(2026, 8, 1) + h * 3600_000).toISOString(), source: 'sensor', demo: true });

describe('alert replay', () => {
  it('dedupes: one alert per cage+rule until it clears, with firstFiredAt and clearedAt', async () => {
    const rs = await buildChain([mk(0, 'do', 6), mk(6, 'do', 4.6), mk(12, 'do', 4.4), mk(18, 'do', 3.8), mk(24, 'do', 5.2), mk(30, 'do', 4.9)]);
    const alerts = replayAlerts(rs, [cage], Date.UTC(2026, 8, 2, 12));
    const doAlerts = alerts.filter((a) => a.rule === 'do');
    expect(doAlerts).toHaveLength(2);
    const first = doAlerts.find((a) => a.firstFiredAt === mk(6, 'do', 0).ts)!;
    expect(first).toMatchObject({ active: false, clearedAt: mk(24, 'do', 0).ts, peak: 'critical', severity: 'critical' });
    const second = doAlerts.find((a) => a.firstFiredAt === mk(30, 'do', 0).ts)!;
    expect(second).toMatchObject({ active: true, severity: 'watch' });
    expect(second.clearedAt).toBeUndefined();
  });
  it('a missing reading is never OK: stale alert after 24 h on a sensor cage', async () => {
    const rs = await buildChain([mk(0, 'do', 6), mk(1, 'temp', 27)]);
    const fresh = replayAlerts(rs, [cage], Date.UTC(2026, 8, 2, 0));
    expect(fresh.filter((a) => a.rule === 'stale')).toHaveLength(0);
    const later = replayAlerts(rs, [cage], Date.UTC(2026, 8, 2, 12));
    expect(later.find((a) => a.rule === 'stale')).toMatchObject({ active: true, severity: 'watch' });
    expect(replayAlerts(rs, [{ ...cage, sensor: false }], Date.UTC(2026, 8, 5)).filter((a) => a.rule === 'stale')).toHaveLength(0);
  });
  it('weather alerts come from the forecast and are farm-level', () => {
    const a = replayAlerts([], [cage], NOW, { source: 'demo', issuedAt: new Date(NOW).toISOString(), windKmh: 46, rainMm: 25, tempMaxC: 30 });
    expect(a.map((x) => `${x.rule}:${x.severity}`).sort()).toEqual(['rain:watch', 'wind:critical']);
    expect(a.every((x) => x.cageId === null)).toBe(true);
  });
  it('turnover needs a deep probe', async () => {
    const withProbe: Cage = { ...cage, depthProbe: true };
    const rs = await buildChain([mk(0, 'do', 6), mk(0, 'temp', 28), mk(0, 'temp_deep', 26), mk(6, 'do', 5.5), mk(6, 'temp', 28), mk(6, 'temp_deep', 25.5), mk(12, 'do', 4.9), mk(12, 'temp', 28), mk(12, 'temp_deep', 24.8)]);
    expect(replayAlerts(rs, [cage], Date.UTC(2026, 8, 1, 13)).some((a) => a.rule === 'turnover')).toBe(false);
    const t = replayAlerts(rs, [withProbe], Date.UTC(2026, 8, 1, 13)).find((a) => a.rule === 'turnover');
    expect(t).toMatchObject({ severity: 'watch', active: true });
  });
});

describe('demo world alerts', () => {
  it('cage 3 low-oxygen episode fires DO and turnover alerts, plus one storm-forecast alert', async () => {
    const w = await getWorld();
    const farm = w.farms.find((f) => f.id === DEMO_FARM_ID)!;
    const rs = w.readings.filter((r) => r.farmId === farm.id);
    const alerts = replayAlerts(rs, farm.cages, NOW, demoForecast(NOW));
    const active = alerts.filter((a) => a.active);
    expect(active.filter((a) => a.cageId === `${farm.id}-c3`).map((a) => a.rule).sort()).toEqual(['do', 'turnover']);
    expect(active.find((a) => a.rule === 'do')).toMatchObject({ severity: 'critical', params: { value: 3.8 } });
    expect(active.filter((a) => a.cageId === null).map((a) => a.rule)).toEqual(['wind']);
    // Only cage 3 needs attention among cages; earlier events are cleared history.
    expect(new Set(active.filter((a) => a.cageId).map((a) => a.cageId))).toEqual(new Set([`${farm.id}-c3`]));
    expect(alerts.some((a) => !a.active && a.clearedAt)).toBe(true);
  });
  it('days lost KPI counts critical-alert days and incident days', async () => {
    const w = await getWorld();
    const farm = w.farms.find((f) => f.id === DEMO_FARM_ID)!;
    const rs = w.readings.filter((r) => r.farmId === farm.id);
    const alerts = replayAlerts(rs, farm.cages, NOW, demoForecast(NOW));
    const k = daysLostToIncidents(alerts, rs, NOW);
    expect(k.count).toBe(5); // 3 incident days + 2 days with the critical episode (28 and 29 Sep)
    const clean = w.farms.find((f) => f.id === 'farm-baraka')!;
    const rc = w.readings.filter((r) => r.farmId === clean.id);
    expect(daysLostToIncidents(replayAlerts(rc, clean.cages, NOW), rc, NOW).count).toBe(0);
  });
});
