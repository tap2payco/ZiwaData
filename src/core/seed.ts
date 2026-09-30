import { DEMO_BUILD } from './config';
import { buildChain } from './hashchain';
import { DAY_MS, EAT_OFFSET_MS, HOUR_MS, startOfDay } from './format';
import { Rng } from './prng';
import type { Cage, Farm, Kind, Reading, ReadingDraft } from './types';
import { byTime } from './alerts';

/**
 * Deterministic DEMO DATA. Seeded PRNG: the same clock gives the same numbers. Nothing here is a real farm, person,
 * lender or measurement. Borrowers are invented, first names only.
 */
export const DEMO_FARM_ID = 'farm-demo';
export const DEMO_TAMPERED_FARM_ID = 'farm-salma';
export const TAMPER_SEQ = 57;

const UNIT: Record<Kind, string> = { do: 'mg/L', temp: '°C', temp_deep: '°C', ph: 'pH', feed: 'kg', mortality: 'fish', incident: '' };
const r1 = (v: number) => Math.round(v * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const diurnal = (ts: number) => Math.sin((2 * Math.PI * ((((ts + EAT_OFFSET_MS) / HOUR_MS) % 24) - 9)) / 24);

const mkCage = (farmId: string, n: number, sensor: boolean, depthProbe: boolean, deviceId?: string): Cage => ({ id: `${farmId}-c${n}`, farmId, number: n, sensor, depthProbe, deviceId });

export function demoFarms(): Farm[] {
  const f = (id: string, name: string, ownerName: string, site: string, cages: Cage[], assigned: boolean): Farm => ({ id, name, ownerName, site, lat: -2.52, lon: 32.9, cages, assigned });
  return [
    f(DEMO_FARM_ID, 'Demo farm — Mwanza Gulf', 'Amina', 'Mwanza Gulf (demo point)', [
      mkCage(DEMO_FARM_ID, 1, true, true, 'demo-ws-1'), mkCage(DEMO_FARM_ID, 2, true, false, 'demo-ws-1'), mkCage(DEMO_FARM_ID, 3, true, true, 'demo-ws-2'),
      mkCage(DEMO_FARM_ID, 4, true, false, 'demo-ws-2'), mkCage(DEMO_FARM_ID, 5, false, false), mkCage(DEMO_FARM_ID, 6, false, false),
    ], true),
    f('farm-baraka', "Baraka's cages (demo)", 'Baraka', 'Mwanza Gulf, demo site B', [mkCage('farm-baraka', 1, true, true, 'demo-ws-b1'), mkCage('farm-baraka', 2, true, false, 'demo-ws-b1'), mkCage('farm-baraka', 3, true, false, 'demo-ws-b1')], true),
    f('farm-neema', "Neema's cages (demo)", 'Neema', 'Mwanza Gulf, demo site N', [mkCage('farm-neema', 1, false, false), mkCage('farm-neema', 2, false, false)], true),
    f('farm-juma', "Juma's cages (demo)", 'Juma', 'Mwanza Gulf, demo site J', [mkCage('farm-juma', 1, true, false, 'demo-ws-j1'), mkCage('farm-juma', 2, false, false)], false),
    f(DEMO_TAMPERED_FARM_ID, "Salma's cages (demo)", 'Salma', 'Mwanza Gulf, demo site S', [mkCage(DEMO_TAMPERED_FARM_ID, 1, true, false, 'demo-ws-s1'), mkCage(DEMO_TAMPERED_FARM_ID, 2, false, false)], false),
  ];
}

interface Builder {
  farm: Farm;
  now: number;
  rng: Rng;
  out: ReadingDraft[];
  add: (cage: Cage, kind: Kind, value: number | string, ts: number, extra?: Partial<ReadingDraft>) => void;
}
function builder(farm: Farm, now: number): Builder {
  const out: ReadingDraft[] = [];
  return {
    farm, now, rng: new Rng(`seed:${farm.id}`), out,
    add(cage, kind, value, ts, extra = {}) {
      if (ts > now - 60_000) return;
      const sensorKind = kind === 'do' || kind === 'temp' || kind === 'temp_deep';
      out.push({
        cageId: cage.id, farmId: farm.id, kind, value: typeof value === 'number' ? r1(value) : value, unit: UNIT[kind], ts: new Date(ts).toISOString(),
        source: 'manual', via: 'app', demo: DEMO_BUILD, ...(sensorKind && extra.source === 'sensor' ? { deviceId: cage.deviceId } : {}), ...extra,
      });
    },
  };
}

/** Sensor readings every `stepH` hours (DO + temp, + deep temp on probe cages). `override` may replace values by index k (0 = newest). */
function sensorSeries(b: Builder, cage: Cage, opts: { stepH?: number; days?: number; latestAgoMin?: number; doBase: number; tempBase?: number; skip?: (hoursAgo: number, k: number) => boolean; doAt?: (k: number, hoursAgo: number) => number | undefined; deltaAt?: (k: number, hoursAgo: number) => number | undefined; endBeforeH?: number }) {
  const step = opts.stepH ?? 6;
  const n = Math.floor(((opts.days ?? 30) * 24) / step);
  const latest = b.now - (opts.latestAgoMin ?? 35) * 60_000 - (cage.number - 1) * 2 * 60_000;
  for (let k = 0; k < n; k++) {
    const ts = latest - k * step * HOUR_MS;
    const hoursAgo = (b.now - ts) / HOUR_MS;
    if (opts.endBeforeH !== undefined && hoursAgo < opts.endBeforeH) continue;
    if (opts.skip?.(hoursAgo, k)) continue;
    const d = diurnal(ts);
    const doNormal = clamp(opts.doBase + 0.6 * d + 0.22 * b.rng.noise(), 5.4, 9);
    const doV = opts.doAt?.(k, hoursAgo) ?? doNormal;
    const temp = clamp((opts.tempBase ?? 27.4) + 1.4 * diurnal(ts - 6 * HOUR_MS) + 0.3 * b.rng.noise(), 24.5, 30.5);
    b.add(cage, 'do', doV, ts, { source: 'sensor' });
    b.add(cage, 'temp', temp, ts, { source: 'sensor' });
    if (cage.depthProbe) {
      const delta = opts.deltaAt?.(k, hoursAgo) ?? clamp(1.2 + 0.3 * b.rng.noise(), 0.8, 2.0);
      b.add(cage, 'temp_deep', temp - delta, ts, { source: 'sensor' });
    }
  }
}

/** One manual entry per day at about 07:30 (East Africa Time). */
function dailyManual(b: Builder, cage: Cage, o: { days?: number; skipP?: number; skip?: (dAgo: number) => boolean; doBase?: number; tempBase?: number; ph?: boolean; feed?: number; mortality?: (dAgo: number) => number; feedAt?: (dAgo: number) => number | undefined; doAt?: (dAgo: number) => number | undefined; phAt?: (dAgo: number) => number | undefined; jitter?: boolean }) {
  const today = startOfDay(b.now);
  for (let d = (o.days ?? 30) - 1; d >= 0; d--) {
    if (o.skip?.(d) || (o.skipP && b.rng.chance(o.skipP))) continue;
    const ts = today - d * DAY_MS + 7.5 * HOUR_MS + b.rng.int(0, 25) * 60_000 + cage.number * 60_000;
    if (o.doBase !== undefined) {
      const v = o.doAt?.(d) ?? clamp(o.doBase + 0.35 * b.rng.noise(), o.doBase < 5.2 ? 4.2 : 5.1, 8);
      b.add(cage, 'do', v, ts, { via: 'app' });
      b.add(cage, 'temp', clamp((o.tempBase ?? 26.8) + 0.4 * b.rng.noise(), 24.5, 30), ts + 60_000, { via: 'app' });
    }
    if (o.ph !== false) b.add(cage, 'ph', o.phAt?.(d) ?? clamp(7.6 + 0.2 * b.rng.noise(), 7.0, 8.2), ts + 2 * 60_000, { via: 'app' });
    if (o.feed) b.add(cage, 'feed', o.feedAt?.(d) ?? o.feed + 4 * b.rng.noise(), ts + 3 * 60_000, { via: 'app' });
    b.add(cage, 'mortality', o.mortality ? o.mortality(d) : b.rng.chance(0.3) ? 0 : b.rng.int(0, 2), ts + 4 * 60_000, { via: 'app' });
  }
}

const incident = (b: Builder, cage: Cage, daysAgo: number, type: string, note: string) =>
  b.add(cage, 'incident', type, startOfDay(b.now) - daysAgo * DAY_MS + 8 * HOUR_MS, { via: 'app', unit: '', note });

const attest = (b: Builder, cage: Cage, daysAgo: number, doV: number, tempV: number, calibrated: string) => {
  const ts = startOfDay(b.now) - daysAgo * DAY_MS + 10.5 * HOUR_MS;
  const extra = { via: 'attestation' as const, attested: true, meterCalibratedOn: calibrated, attestedBy: 'Extension officer (demo)' };
  b.add(cage, 'do', doV, ts, extra);
  b.add(cage, 'temp', tempV, ts + 60_000, extra);
};

function buildFarm(farm: Farm, now: number): ReadingDraft[] {
  const b = builder(farm, now);
  const c = (n: number) => farm.cages.find((x) => x.number === n)!;
  switch (farm.id) {
    case DEMO_FARM_ID: {
      // Cage 3 low-oxygen episode. k = sensor step index (0 newest, 6 h apart). Deep-temperature gap widens with it.
      const episodeDo: Record<number, number> = { 0: 3.8, 1: 3.4, 2: 3.6, 3: 4.3, 4: 4.9, 5: 5.6, 6: 6.0 };
      const episodeDelta: Record<number, number> = { 0: 3.4, 1: 3.7, 2: 3.8, 3: 3.6, 4: 3.1, 5: 2.3, 6: 1.8 };
      sensorSeries(b, c(1), { doBase: 6.6 });
      // Cage 2: sensor and visits stopped for 4 days (10 to 14 days ago).
      sensorSeries(b, c(2), { doBase: 6.3, skip: (h) => h >= 244 && h <= 338 });
      sensorSeries(b, c(3), { doBase: 6.4, doAt: (k) => episodeDo[k], deltaAt: (k) => episodeDelta[k] });
      // Cage 4: a short low-DO spell 6 days ago that cleared.
      sensorSeries(b, c(4), { doBase: 6.2, doAt: (k) => (k === 24 ? 4.7 : k === 25 ? 4.5 : undefined) });
      dailyManual(b, c(1), { feed: 60, skipP: 0.07, mortality: () => (b.rng.chance(0.4) ? 0 : 1) });
      dailyManual(b, c(2), { feed: 55, skipP: 0.07, skip: (d) => d >= 10 && d <= 14 });
      dailyManual(b, c(3), { feed: 58, skipP: 0.05, feedAt: (d) => (d === 0 ? 20 : d === 1 ? 30 : undefined), mortality: (d) => (d === 0 ? 22 : d === 1 ? 6 : b.rng.chance(0.3) ? 0 : b.rng.int(0, 2)) });
      dailyManual(b, c(4), { feed: 62, skipP: 0.07 });
      dailyManual(b, c(5), { feed: 50, skipP: 0.1, doBase: 5.9, tempBase: 26.6, phAt: (d) => (d === 10 ? 9.2 : undefined) });
      incident(b, c(4), 12, 'predator', '@demo.bird');
      incident(b, c(5), 6, 'poaching', '@demo.net');
      incident(b, c(2), 21, 'storm', '@demo.storm');
      break;
    }
    case 'farm-baraka': {
      for (const n of [1, 2, 3]) {
        sensorSeries(b, c(n), { doBase: 6.7 + n * 0.05, tempBase: 27.2 });
        dailyManual(b, c(n), { feed: 70, skipP: 0.02, mortality: () => (b.rng.chance(0.65) ? 0 : 1) });
      }
      attest(b, c(1), 21, 6.4, 27.1, '2026-08-30');
      attest(b, c(1), 10, 6.6, 27.4, '2026-08-30');
      attest(b, c(1), 3, 6.5, 27.0, '2026-08-30');
      break;
    }
    case 'farm-neema': {
      dailyManual(b, c(1), { feed: 40, doBase: 5.7, skipP: 0.1, doAt: (d) => (d === 17 || d === 16 ? 4.8 : undefined) });
      dailyManual(b, c(2), { feed: 38, doBase: 5.6, skipP: 0.1, mortality: () => (b.rng.chance(0.4) ? 0 : 1) });
      break;
    }
    case 'farm-juma': {
      // Sensor gap in the middle, and NOTHING for the last 5 days.
      sensorSeries(b, c(1), { doBase: 6.0, endBeforeH: 5 * 24, skip: (h) => h >= 8 * 24 && h <= 22 * 24, doAt: (_k, h) => (h > 8.2 * 24 && h < 9.2 * 24 ? 4.6 : undefined) });
      dailyManual(b, c(1), { feed: 45, ph: true, skip: (d) => d < 5 || (d >= 8 && d <= 22), mortality: (d) => (d < 12 ? b.rng.int(3, 6) : b.rng.int(0, 2)) });
      dailyManual(b, c(2), { feed: 40, doBase: 4.9, skip: (d) => d < 5 || d % 2 === 1, mortality: (d) => (d < 12 ? b.rng.int(2, 5) : b.rng.int(0, 1)) });
      break;
    }
    case DEMO_TAMPERED_FARM_ID: {
      sensorSeries(b, c(1), { stepH: 12, doBase: 6.2 });
      dailyManual(b, c(1), { feed: 50, skipP: 0.05 });
      dailyManual(b, c(2), { feed: 46, doBase: 5.8, skipP: 0.06 });
      attest(b, c(2), 4, 5.9, 26.9, '2026-09-01');
      break;
    }
  }
  return b.out.sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts) || (x.kind < y.kind ? -1 : 1) || (x.cageId < y.cageId ? -1 : 1));
}

export interface DemoWorld {
  farms: Farm[];
  readings: Reading[];
  seededAt: number;
}

/** Generate all demo farms and their hash-chained readings. The Salma record is edited AFTER hashing, on purpose. */
export async function generateWorld(now: number): Promise<DemoWorld> {
  const farms = demoFarms();
  const readings: Reading[] = [];
  for (const farm of farms) {
    const drafts = buildFarm(farm, now).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const chain = await buildChain(drafts);
    if (farm.id === DEMO_TAMPERED_FARM_ID) {
      const i = chain.findIndex((r) => r.seq === TAMPER_SEQ);
      const rec = chain[i]!;
      if (typeof rec.value === 'number') chain[i] = { ...rec, value: Math.round((rec.value + 1.5) * 10) / 10 }; // hash left unchanged: chain now breaks here
    }
    readings.push(...chain);
  }
  return { farms, readings, seededAt: now };
}

export const sortReadings = (rs: Reading[]) => [...rs].sort(byTime);
