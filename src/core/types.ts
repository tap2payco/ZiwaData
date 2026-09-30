export type Kind = 'do' | 'temp' | 'ph' | 'temp_deep' | 'feed' | 'mortality' | 'incident';
export type Source = 'manual' | 'sensor' | 'satellite';
export type Via = 'app' | 'sms' | 'attestation';
export type Status = 'ok' | 'watch' | 'critical' | 'none';
export type IncidentType = 'predator' | 'poaching' | 'storm' | 'disease' | 'other';
export type Lang = 'sw' | 'en';

/** A reading without its hash. `hash = SHA-256(prevHash + canonicalJSON(body))`. */
export interface ReadingBody {
  id: string;
  seq: number;
  cageId: string;
  farmId: string;
  kind: Kind;
  /** Number for measurements; incident type string for kind 'incident'. */
  value: number | string;
  unit: string;
  ts: string; // ISO 8601 UTC
  source: Source;
  via?: Via;
  deviceId?: string;
  attested?: boolean;
  demo: boolean;
  note?: string;
  meterCalibratedOn?: string; // attestation only, YYYY-MM-DD
  photoName?: string; // attestation only; the photo itself is not stored in the demo
  attestedBy?: string;
  prevHash: string;
}
export interface Reading extends ReadingBody {
  hash: string;
}
/** What a caller supplies; seq, id (optional) and hashes are added by the chain. */
export type ReadingDraft = Omit<ReadingBody, 'id' | 'seq' | 'prevHash'> & { id?: string };

export interface Cage {
  id: string;
  farmId: string;
  number: number;
  /** Has a Space-IoT sensor feeding DO and temperature. */
  sensor: boolean;
  /** Has a deep temperature probe (needed for turnover risk). */
  depthProbe: boolean;
  deviceId?: string;
}
export interface Farm {
  id: string;
  name: string;
  ownerName: string; // first name only
  site: string;
  lat: number;
  lon: number;
  cages: Cage[];
  /** Assigned to the extension officer in the demo. */
  assigned: boolean;
}

export type RuleId = 'do' | 'temp' | 'ph' | 'turnover' | 'wind' | 'rain' | 'stale';
export interface AlertParams {
  value?: number;
  threshold?: number;
  limitKind?: 'low' | 'high';
  deltaC?: number;
  doDrop?: number;
  hours?: number;
}
export interface Alert {
  id: string;
  farmId: string;
  cageId: string | null; // null = whole farm (weather)
  rule: RuleId;
  severity: 'watch' | 'critical';
  peak: 'watch' | 'critical';
  firstFiredAt: string;
  clearedAt?: string;
  active: boolean;
  params: AlertParams;
  /** True when built from a live Box field mapping that has not been verified. */
  unverified?: boolean;
}

export interface Forecast {
  source: 'demo' | 'live';
  issuedAt: string;
  windKmh: number | null;
  rainMm: number | null;
  tempMaxC: number | null;
  unverified?: boolean;
}

export type SmsState = 'queued' | 'sent' | 'failed' | 'dry_run';

export interface Checkpoint {
  receivedAt: string;
  farmId: string;
  headHash: string;
  headSeq: number;
  count: number;
  chainOk: boolean;
  brokenAtSeq?: number;
}
