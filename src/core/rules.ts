import { RULES } from './config';
import type { Kind, Status } from './types';

type Cfg = typeof RULES;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Worst state wins. `none` only when nothing is known. */
export function worst(...s: Status[]): Status {
  if (s.includes('critical')) return 'critical';
  if (s.includes('watch')) return 'watch';
  if (s.includes('ok')) return 'ok';
  return 'none';
}

/** Dissolved oxygen, mg/L. OK >= 5.0; Watch 4.0 to <5.0; Critical < 4.0. Unknown is 'none', never OK. */
export function classifyDo(v: number | null | undefined, cfg: Cfg = RULES): Status {
  if (!isNum(v)) return 'none';
  if (v < cfg.do.criticalBelow) return 'critical';
  if (v < cfg.do.okMin) return 'watch';
  return 'ok';
}

/** Water temperature, degC. OK 24-31; Watch 20-<24 or >31-34; Critical <20 or >34. */
export function classifyTemp(v: number | null | undefined, cfg: Cfg = RULES): Status {
  if (!isNum(v)) return 'none';
  const t = cfg.temp;
  if (v < t.watchMin || v > t.watchMax) return 'critical';
  if (v < t.okMin || v > t.okMax) return 'watch';
  return 'ok';
}

/** pH. OK 6.5-9.0; Watch 6.0-<6.5 or >9.0-9.5; Critical outside 6.0-9.5. */
export function classifyPh(v: number | null | undefined, cfg: Cfg = RULES): Status {
  if (!isNum(v)) return 'none';
  const p = cfg.ph;
  if (v < p.watchMin || v > p.watchMax) return 'critical';
  if (v < p.okMin || v > p.okMax) return 'watch';
  return 'ok';
}

export type TurnoverReason = 'no_probe' | 'no_data' | 'clear' | 'risk';
export interface TurnoverResult {
  status: Status;
  reason: TurnoverReason;
  deltaC?: number;
  doDrop?: number;
  latestDo?: number;
}
/**
 * Turnover / thermal stratification risk. Needs a deep temperature probe.
 * surface - deep >= 3 degC AND DO falling (drop >= 1.0 mg/L over the last 3 readings) -> Watch;
 * surface - deep >= 3 degC AND DO < 4.0 -> Critical.
 */
export function evaluateTurnover(
  input: { surface?: number | null; deep?: number | null; doSeries: number[] },
  cfg: Cfg = RULES,
): TurnoverResult {
  if (!isNum(input.deep)) return { status: 'none', reason: 'no_probe' };
  if (!isNum(input.surface)) return { status: 'none', reason: 'no_data' };
  const t = cfg.turnover;
  const deltaC = Math.round((input.surface - input.deep) * 10) / 10;
  const series = input.doSeries.filter(isNum).slice(-t.doReadings);
  const latestDo = series.length ? series[series.length - 1] : undefined;
  const doDrop = series.length >= 2 ? Math.round((series[0]! - series[series.length - 1]!) * 10) / 10 : 0;
  if (deltaC < t.deltaC) return { status: 'ok', reason: 'clear', deltaC, doDrop, latestDo };
  if (latestDo !== undefined && latestDo < t.criticalDo) return { status: 'critical', reason: 'risk', deltaC, doDrop, latestDo };
  if (doDrop >= t.doDrop) return { status: 'watch', reason: 'risk', deltaC, doDrop, latestDo };
  return { status: 'ok', reason: 'clear', deltaC, doDrop, latestDo };
}

export interface WeatherResult {
  wind: Status;
  rain: Status;
  overall: Status;
}
/** Forecast wind >= 30 km/h Watch, >= 45 Critical; forecast rain >= 20 mm Watch. Weather only, not water quality. */
export function classifyWeather(f: { windKmh?: number | null; rainMm?: number | null }, cfg: Cfg = RULES): WeatherResult {
  const w = cfg.weather;
  const wind: Status = !isNum(f.windKmh) ? 'none' : f.windKmh >= w.windCriticalKmh ? 'critical' : f.windKmh >= w.windWatchKmh ? 'watch' : 'ok';
  const rain: Status = !isNum(f.rainMm) ? 'none' : f.rainMm >= w.rainWatchMm ? 'watch' : 'ok';
  return { wind, rain, overall: worst(wind, rain) };
}

/** No reading for more than 24 h on a sensor cage is Watch, never OK. */
export function isStale(lastTs: number | null, now: number, cfg: Cfg = RULES): boolean {
  if (lastTs === null) return false;
  return now - lastTs > cfg.stale.hours * 3_600_000;
}

export type FeedLevel = 'normal' | 'half' | 'pause' | 'secure_pause';
/**
 * Feeding guidance (rules, to be confirmed by fisheries experts before farmers rely on them):
 * DO Watch -> half rations; DO Critical or turnover risk -> pause until DO > 5.5 on two readings;
 * weather Critical -> secure cages and pause feeding.
 */
export function feedingLevel(x: { doStatus: Status; turnoverStatus: Status; weatherStatus?: Status }): FeedLevel {
  if (x.weatherStatus === 'critical') return 'secure_pause';
  if (x.doStatus === 'critical' || x.turnoverStatus === 'watch' || x.turnoverStatus === 'critical') return 'pause';
  if (x.doStatus === 'watch') return 'half';
  return 'normal';
}
/** True once the last two DO readings are both above the resume line (5.5 mg/L). */
export function canResumeFeeding(doSeries: number[], cfg: Cfg = RULES): boolean {
  const need = cfg.feeding.resumeReadings;
  const s = doSeries.filter(isNum);
  return s.length >= need && s.slice(-need).every((v) => v > cfg.feeding.resumeDo);
}

export function isPlausible(kind: Kind, value: number | string, cfg: Cfg = RULES): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return kind === 'incident' ? typeof value === 'string' : false;
  const p = cfg.plausible;
  switch (kind) {
    case 'do': return value >= p.do![0] && value <= p.do![1];
    case 'temp': return value >= p.temp![0] && value <= p.temp![1];
    case 'temp_deep': return value >= p.tempDeep![0] && value <= p.tempDeep![1];
    case 'ph': return value >= p.ph![0] && value <= p.ph![1];
    case 'feed': return value >= 0 && value <= 5000;
    case 'mortality': return value >= 0 && Number.isInteger(value) && value <= 100000;
    default: return true;
  }
}

export function classifyKind(kind: Kind, value: number | string | null | undefined): Status {
  if (typeof value !== 'number') return 'none';
  if (kind === 'do') return classifyDo(value);
  if (kind === 'temp') return classifyTemp(value);
  if (kind === 'ph') return classifyPh(value);
  return 'none';
}
