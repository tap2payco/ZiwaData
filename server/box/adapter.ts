import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOX_RANGE } from '../../src/core/config';
import type { Forecast, Kind, ReadingDraft } from '../../src/core/types';
import { demoDevicesPayload, demoWeather } from './demo';

/**
 * Space-IoT Box adapter. Only what the public API spec confirms.
 * Base URL https://api.kijanispace.eu (docs /docs, spec /openapi.json). Only "/" is public.
 *   /v1/agro_climate/water and /land   Bearer, X-API-Key, api_key query or Basic. lat -5.1..2.5, lon 28.95..36.7.
 *        Response schema NOT documented. Earlier inspection: /water returns Meteoblue daily weather, NOT lake water quality.
 *   /v1/devices, /v1/devices/{full_path}   Bearer ONLY (WaziCloud/Keycloak token forwarded by the proxy). An API key does not open it.
 *   /v1/eo/locations, /v1/eo/stac{path}   STAC proxy (Earth observation). Not used in phase 1.
 *   POST /v1/api-keys   Basic (superuser) only: we cannot self-issue a key; KijaniSpace issues it.
 *   /v1/auth/me   Bearer only.
 * Every field mapping below is UNVERIFIED until a real call succeeds. Nothing here was called from this build.
 */
export interface BoxConfig {
  baseUrl: string;
  apiKey?: string;
  bearer?: string;
}
export const DEFAULT_BOX_URL = 'https://api.kijanispace.eu';
export const boxConfigFromEnv = (env: Record<string, string | undefined>): BoxConfig => ({
  baseUrl: (env.BOX_BASE_URL || DEFAULT_BOX_URL).replace(/\/+$/, ''),
  apiKey: env.BOX_API_KEY?.trim() || undefined,
  bearer: env.BOX_BEARER_TOKEN?.trim() || undefined,
});

export type AuthKind = 'bearer' | 'api_key' | 'basic';
export interface BoxRoute {
  id: string;
  method: 'GET' | 'POST';
  path: string;
  /** Auth methods the spec says the route accepts. */
  auth: AuthKind[];
  /** Used by this app in phase 1? */
  used: boolean;
  /** Which credential the server needs to call it. */
  needs: 'key_or_bearer' | 'bearer' | 'none' | 'superuser';
}
export const BOX_ROUTES: BoxRoute[] = [
  { id: 'water', method: 'GET', path: '/v1/agro_climate/water', auth: ['bearer', 'api_key', 'basic'], used: true, needs: 'key_or_bearer' },
  { id: 'land', method: 'GET', path: '/v1/agro_climate/land', auth: ['bearer', 'api_key', 'basic'], used: false, needs: 'key_or_bearer' },
  { id: 'devices', method: 'GET', path: '/v1/devices', auth: ['bearer'], used: true, needs: 'bearer' },
  { id: 'device_path', method: 'GET', path: '/v1/devices/{full_path}', auth: ['bearer'], used: false, needs: 'bearer' },
  { id: 'eo_locations', method: 'GET', path: '/v1/eo/locations', auth: ['bearer', 'api_key', 'basic'], used: false, needs: 'key_or_bearer' },
  { id: 'eo_stac', method: 'GET', path: '/v1/eo/stac{path}', auth: ['bearer', 'api_key', 'basic'], used: false, needs: 'key_or_bearer' },
  { id: 'api_keys', method: 'POST', path: '/v1/api-keys', auth: ['basic'], used: false, needs: 'superuser' },
  { id: 'auth_me', method: 'GET', path: '/v1/auth/me', auth: ['bearer'], used: false, needs: 'bearer' },
];

export interface TestResult {
  at: string;
  ok: boolean;
  httpStatus?: number;
  error?: string;
}
export interface RouteStatus {
  id: string;
  method: string;
  path: string;
  auth: AuthKind[];
  used: boolean;
  /** A credential that can call this route is set on the server (the value is never returned). */
  configured: boolean;
  lastTest: TestResult | null;
  /** 'live' ONLY when configured AND a test call succeeded in this server session. Otherwise 'demo'. */
  mode: 'demo' | 'live';
}
export interface BoxStatus {
  baseUrl: string;
  keyConfigured: boolean;
  bearerConfigured: boolean;
  routes: RouteStatus[];
}

const inRange = (lat: number, lon: number) => lat >= BOX_RANGE.latMin && lat <= BOX_RANGE.latMax && lon >= BOX_RANGE.lonMin && lon <= BOX_RANGE.lonMax;
export const boxPointValid = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) && inRange(lat, lon);

// ---------------------------------------------------------------------------------------------
// Normalising layer. mapWeatherPayload and mapDevicePayload are the ONE place to edit once real payloads are known.
// ---------------------------------------------------------------------------------------------

/** Breadth-first search for the first key (case-insensitive) in `keys`, depth <= 4. */
function findKey(obj: unknown, keys: string[]): unknown {
  const want = new Set(keys.map((k) => k.toLowerCase()));
  const queue: { v: unknown; d: number }[] = [{ v: obj, d: 0 }];
  while (queue.length) {
    const { v, d } = queue.shift()!;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (want.has(k.toLowerCase())) return val;
      if (d < 4) for (const val of Object.values(v as Record<string, unknown>)) queue.push({ v: val, d: d + 1 });
    } else if (Array.isArray(v) && d < 4) {
      for (const val of v.slice(0, 20)) queue.push({ v: val, d: d + 1 });
    }
  }
  return undefined;
}
const numOf = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
/** Worst case over a daily array (highest value) or the single number. */
const dailyMax = (v: unknown): number | null => {
  if (Array.isArray(v)) {
    const ns = v.map(numOf).filter((n): n is number => n !== null);
    return ns.length ? Math.max(...ns) : null;
  }
  return numOf(v);
};

export interface MappedWeather {
  forecast: Forecast;
  /** Raw values found, before unit conversion, for the Data sources page. */
  raw: { wind: number | null; windUnit: string | null; rain: number | null; rainUnit: string | null; temp: number | null };
}
/**
 * UNVERIFIED mapping for the Meteoblue-style daily weather that /v1/agro_climate/water is believed to return.
 * Wind is converted to km/h ONLY when the payload states its unit; otherwise wind stays null (no weather alert is
 * raised from a number whose unit we do not know). Rain is kept only when the unit is stated as mm.
 */
export function mapWeatherPayload(payload: unknown, now: number): MappedWeather {
  const wind = dailyMax(findKey(payload, ['windspeed_max', 'windspeed_mean', 'wind_speed_max', 'wind_speed', 'windspeed', 'wind_speed_10m_max']));
  const rain = dailyMax(findKey(payload, ['precipitation', 'precipitation_sum', 'rain', 'rainfall', 'precipitationamount']));
  const temp = dailyMax(findKey(payload, ['temperature_max', 'temperature_2m_max', 'temperature_mean', 'temperature']));
  const units = (findKey(payload, ['units', 'metadata_units']) ?? {}) as Record<string, unknown>;
  const windUnit = typeof units.windspeed === 'string' ? units.windspeed : typeof units.wind_speed === 'string' ? units.wind_speed : null;
  const rainUnit = typeof units.precipitation === 'string' ? units.precipitation : typeof units.precipitationamount === 'string' ? units.precipitationamount : null;
  const factor: Record<string, number> = { kmh: 1, 'km/h': 1, 'ms-1': 3.6, 'm/s': 3.6, mph: 1.609344, kn: 1.852 };
  const windKmh = wind !== null && windUnit && factor[windUnit.toLowerCase()] !== undefined ? Math.round(wind * factor[windUnit.toLowerCase()]! * 10) / 10 : null;
  const rainMm = rain !== null && rainUnit && rainUnit.toLowerCase() === 'mm' ? rain : null;
  return {
    forecast: { source: 'live', issuedAt: new Date(now).toISOString(), windKmh, rainMm, tempMaxC: temp, unverified: true },
    raw: { wind, windUnit, rain, rainUnit, temp },
  };
}

export interface MappedDevice {
  id: string;
  name: string;
  type: string;
  lastSeen: string | null;
}
export interface MappedDevices {
  devices: MappedDevice[];
  /** Water measurements as reading drafts. cageId is 'unassigned' until a device-to-cage map is supplied. */
  readings: ReadingDraft[];
  weather: { deviceId: string; windKmh: number | null; rainMm: number | null; tempC: number | null }[];
  skipped: number;
}
const DO_KEYS = ['dissolved_oxygen_mgl', 'dissolved_oxygen', 'do_mgl', 'do_mg_l', 'do', 'oxygen'];
const TEMP_KEYS = ['water_temperature_c', 'water_temperature', 'water_temp', 'temp_c', 'temperature'];
const PH_KEYS = ['ph', 'ph_value'];
const TS_KEYS = ['timestamp', 'ts', 'time', 'last_seen', 'lastseen', 'updated_at'];

/**
 * THE one function to edit when real device payloads are known. Today it parses an ASSUMED shape defensively:
 * an array, or an object with devices/items/data/results holding an array, each with a `latest` (or `data`) object.
 * Anything it cannot parse is skipped and counted, never invented.
 */
export function mapDevicePayload(payload: unknown, opts: { demo: boolean; farmId?: string; deviceCageMap?: Record<string, string> } = { demo: false }): MappedDevices {
  const out: MappedDevices = { devices: [], readings: [], weather: [], skipped: 0 };
  let list: unknown[] = [];
  if (Array.isArray(payload)) list = payload;
  else if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    for (const k of ['devices', 'items', 'data', 'results']) if (Array.isArray(p[k])) { list = p[k] as unknown[]; break; }
  }
  for (const item of list) {
    if (!item || typeof item !== 'object') { out.skipped++; continue; }
    const d = item as Record<string, unknown>;
    const id = typeof d.id === 'string' || typeof d.id === 'number' ? String(d.id) : typeof d.device_id === 'string' ? d.device_id : null;
    if (!id) { out.skipped++; continue; }
    const name = typeof d.name === 'string' ? d.name : id;
    const type = typeof d.type === 'string' ? d.type : 'unknown';
    const latest = (d.latest ?? d.data ?? d.last_measurement ?? d) as unknown;
    const tsRaw = findKey(latest, TS_KEYS) ?? findKey(d, TS_KEYS);
    const tsMs = typeof tsRaw === 'string' ? Date.parse(tsRaw) : typeof tsRaw === 'number' ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000) : NaN;
    const ts = Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : null;
    out.devices.push({ id, name, type, lastSeen: ts });

    const doV = numOf(findKey(latest, DO_KEYS));
    const tV = numOf(findKey(latest, TEMP_KEYS));
    const phV = numOf(findKey(latest, PH_KEYS));
    if (type.includes('weather')) {
      out.weather.push({ deviceId: id, windKmh: numOf(findKey(latest, ['wind_speed_kmh', 'wind_kmh'])), rainMm: numOf(findKey(latest, ['rain_mm', 'precipitation_mm'])), tempC: numOf(findKey(latest, ['air_temperature_c', 'air_temp'])) });
      continue;
    }
    if (!ts) { if (doV !== null || tV !== null || phV !== null) out.skipped++; continue; }
    const cageId = opts.deviceCageMap?.[id] ?? 'unassigned';
    const base = { cageId, farmId: opts.farmId ?? 'unassigned', ts, source: 'sensor' as const, deviceId: id, demo: opts.demo };
    const add = (kind: Kind, value: number | null, unit: string) => { if (value !== null) out.readings.push({ ...base, kind, value, unit }); };
    add('do', doV, 'mg/L');
    add('temp', tV, '°C');
    add('ph', phV, 'pH');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------
export interface WeatherResponse {
  mode: 'demo' | 'live';
  forecast: Forecast;
  /** Why we fell back to demo when a key is configured. */
  liveError?: string;
  raw?: MappedWeather['raw'];
}
export interface DevicesResponse {
  mode: 'demo' | 'live';
  assumedShape: boolean;
  liveError?: string;
  mapped: MappedDevices;
}

export class BoxAdapter {
  private tests = new Map<string, TestResult>();
  constructor(
    private cfg: BoxConfig,
    private opts: { fetchImpl?: typeof fetch; dataDir?: string; now?: () => number; timeoutMs?: number } = {},
  ) {}
  private now = () => (this.opts.now ?? Date.now)();
  private get f() { return this.opts.fetchImpl ?? fetch; }

  private hasCred(needs: BoxRoute['needs']): boolean {
    if (needs === 'bearer') return !!this.cfg.bearer;
    if (needs === 'key_or_bearer') return !!this.cfg.apiKey || !!this.cfg.bearer;
    return false;
  }
  private headersFor(needs: BoxRoute['needs']): Record<string, string> {
    // Bearer-only routes get the token. Key routes prefer the API key header, else the token. Values are never logged.
    if (needs === 'bearer') return this.cfg.bearer ? { Authorization: `Bearer ${this.cfg.bearer}` } : {};
    if (this.cfg.apiKey) return { 'X-API-Key': this.cfg.apiKey };
    if (this.cfg.bearer) return { Authorization: `Bearer ${this.cfg.bearer}` };
    return {};
  }

  status(): BoxStatus {
    return {
      baseUrl: this.cfg.baseUrl,
      keyConfigured: !!this.cfg.apiKey,
      bearerConfigured: !!this.cfg.bearer,
      routes: BOX_ROUTES.map((r) => {
        const configured = this.hasCred(r.needs);
        const lastTest = this.tests.get(r.id) ?? null;
        return { id: r.id, method: r.method, path: r.path, auth: r.auth, used: r.used, configured, lastTest, mode: configured && lastTest?.ok ? 'live' : 'demo' };
      }),
    };
  }

  private async call(route: BoxRoute, path: string): Promise<{ ok: boolean; status?: number; body?: unknown; error?: string }> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 10000);
    try {
      const res = await this.f(this.cfg.baseUrl + path, { method: 'GET', headers: { Accept: 'application/json', ...this.headersFor(route.needs) }, signal: ctl.signal });
      let body: unknown = null;
      try { body = await res.json(); } catch { body = null; }
      const result = { ok: res.ok, status: res.status, body, error: res.ok ? undefined : `http_${res.status}` };
      this.tests.set(route.id, { at: new Date(this.now()).toISOString(), ok: res.ok, httpStatus: res.status, error: result.error });
      if (res.ok) this.logSample(route.id, res.status, body);
      return result;
    } catch (e: any) {
      const error = e?.name === 'AbortError' ? 'timeout' : 'network_error';
      this.tests.set(route.id, { at: new Date(this.now()).toISOString(), ok: false, error });
      return { ok: false, error };
    } finally {
      clearTimeout(t);
    }
  }

  /** On success, keep the raw shape in server/data/box-samples.json so the mapping can be fixed against reality. */
  private logSample(routeId: string, status: number, body: unknown) {
    if (!this.opts.dataDir) return;
    try {
      mkdirSync(this.opts.dataDir, { recursive: true });
      const file = join(this.opts.dataDir, 'box-samples.json');
      let arr: unknown[] = [];
      try { arr = JSON.parse(readFileSync(file, 'utf8')); } catch { arr = []; }
      const text = JSON.stringify(body);
      arr.push({ at: new Date(this.now()).toISOString(), route: routeId, status, payload: text.length > 200_000 ? { truncated: true, bytes: text.length } : body });
      writeFileSync(file, JSON.stringify(arr.slice(-20), null, 1));
    } catch { /* logging must never break a request */ }
  }

  weatherPath(lat: number, lon: number) {
    const q = new URLSearchParams({ lat: String(lat), lon: String(lon) });
    return `/v1/agro_climate/water?${q}`;
  }

  async weather(lat: number, lon: number): Promise<WeatherResponse> {
    const route = BOX_ROUTES.find((r) => r.id === 'water')!;
    const now = this.now();
    if (!this.hasCred(route.needs)) return { mode: 'demo', forecast: demoWeather(now) };
    const res = await this.call(route, this.weatherPath(lat, lon));
    if (!res.ok) return { mode: 'demo', forecast: demoWeather(now), liveError: res.error };
    const mapped = mapWeatherPayload(res.body, now);
    return { mode: 'live', forecast: mapped.forecast, raw: mapped.raw };
  }

  async devices(): Promise<DevicesResponse> {
    const route = BOX_ROUTES.find((r) => r.id === 'devices')!;
    const now = this.now();
    if (!this.hasCred('bearer')) return { mode: 'demo', assumedShape: true, mapped: mapDevicePayload(demoDevicesPayload(now), { demo: true }) };
    const res = await this.call(route, route.path);
    if (!res.ok) return { mode: 'demo', assumedShape: true, liveError: res.error, mapped: mapDevicePayload(demoDevicesPayload(now), { demo: true }) };
    return { mode: 'live', assumedShape: true, mapped: mapDevicePayload(res.body, { demo: false }) };
  }

  /** Test every route we use and can authenticate to. Routes without a credential are skipped, never faked. */
  async test(): Promise<BoxStatus> {
    await this.weather(-2.52, 32.9);
    await this.devices();
    return this.status();
  }
}
