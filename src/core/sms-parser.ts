import type { Lang } from './types';

/**
 * Inbound SMS commands (SIMULATED unless Beem inbound is configured, which is a gap to ask Beem about).
 *   sw: RIPOTI K3 OKS 5.2 JOTO 27.5 PH 7.4      en: REPORT C3 DO 5.2 T 27.5 PH 7.4
 * Also accepted: CHAKULA/FEED (kg) and FA/DEAD (dead fish). Decimal comma is accepted.
 */
export type ParseError =
  | 'empty' | 'unknown_command' | 'no_cage' | 'bad_cage' | 'no_values' | 'unknown_field' | 'missing_value' | 'bad_number' | 'duplicate_field' | 'out_of_range';

export interface SmsValues {
  do?: number;
  temp?: number;
  ph?: number;
  feed?: number;
  dead?: number;
}
export type ParsedSms =
  | { ok: true; lang: Lang; cageNumber: number; values: SmsValues; summary: string }
  | { ok: false; error: ParseError; field?: string; lang: Lang | null };

const FIELDS: Record<string, keyof SmsValues> = { OKS: 'do', DO: 'do', JOTO: 'temp', T: 'temp', TEMP: 'temp', PH: 'ph', CHAKULA: 'feed', FEED: 'feed', FA: 'dead', DEAD: 'dead', WALIOKUFA: 'dead' };
const RANGES: Record<keyof SmsValues, [number, number]> = { do: [0, 20], temp: [10, 40], ph: [4, 11], feed: [0, 5000], dead: [0, 100000] };
const LABEL: Record<Lang, Record<keyof SmsValues, string>> = {
  sw: { do: 'OKS', temp: 'JOTO', ph: 'PH', feed: 'CHAKULA', dead: 'FA' },
  en: { do: 'DO', temp: 'T', ph: 'PH', feed: 'FEED', dead: 'DEAD' },
};

export function parseInboundSms(raw: string): ParsedSms {
  const text = (raw ?? '').trim().toUpperCase();
  if (!text) return { ok: false, error: 'empty', lang: null };
  const tokens = text.split(/\s+/);
  const cmd = tokens.shift()!;
  const lang: Lang | null = cmd === 'RIPOTI' ? 'sw' : cmd === 'REPORT' ? 'en' : null;
  if (!lang) return { ok: false, error: 'unknown_command', lang: null };

  const cageTok = tokens.shift();
  if (!cageTok) return { ok: false, error: 'no_cage', lang };
  const m = /^(K|C|KIZIMBA|CAGE)(\d*)$/.exec(cageTok);
  if (!m) return { ok: false, error: 'bad_cage', field: cageTok, lang };
  let digits = m[2]!;
  if (!digits) {
    const next = tokens[0];
    if (next && /^\d+$/.test(next)) digits = tokens.shift()!;
  }
  const cageNumber = Number(digits);
  if (!digits || !Number.isInteger(cageNumber) || cageNumber < 1 || cageNumber > 99) return { ok: false, error: 'bad_cage', field: cageTok, lang };

  const values: SmsValues = {};
  while (tokens.length) {
    const key = tokens.shift()!;
    const field = FIELDS[key];
    if (!field) return { ok: false, error: 'unknown_field', field: key, lang };
    const valTok = tokens.shift();
    if (valTok === undefined) return { ok: false, error: 'missing_value', field: key, lang };
    if (!/^\d+([.,]\d+)?$/.test(valTok)) return { ok: false, error: 'bad_number', field: key, lang };
    if (values[field] !== undefined) return { ok: false, error: 'duplicate_field', field: key, lang };
    const v = Number(valTok.replace(',', '.'));
    const [lo, hi] = RANGES[field];
    if (v < lo || v > hi || (field === 'dead' && !Number.isInteger(v))) return { ok: false, error: 'out_of_range', field: key, lang };
    values[field] = v;
  }
  if (Object.keys(values).length === 0) return { ok: false, error: 'no_values', lang };
  const order: (keyof SmsValues)[] = ['do', 'temp', 'ph', 'feed', 'dead'];
  const summary = order
    .filter((k) => values[k] !== undefined)
    .map((k) => `${LABEL[lang][k]} ${k === 'dead' ? values[k] : k === 'feed' ? values[k] : values[k]!.toFixed(1)}`)
    .join(', ');
  return { ok: true, lang, cageNumber, values, summary };
}
