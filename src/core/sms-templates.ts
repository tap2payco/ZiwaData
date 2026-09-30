import { BRAND } from '../brand';
import type { Alert, Lang } from './types';

/**
 * SMS templates. Every alert must fit ONE SMS: 160 characters, GSM-7 only (no degree sign, no accents outside the
 * GSM set, no emoji). Swahili wording NEEDS NATIVE REVIEW before real use.
 */
export const SMS_MAX = 160;

// GSM 03.38 basic character set (without the escape/extension table). Newline and CR allowed.
const GSM7 = new Set(
  Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"),
);
export const isGsm7 = (s: string) => Array.from(s).every((c) => GSM7.has(c));
export const smsLength = (s: string) => Array.from(s).length;

export type SmsTemplateId =
  | 'do_watch' | 'do_critical' | 'temp_watch' | 'temp_critical' | 'ph_watch' | 'ph_critical'
  | 'turnover_watch' | 'turnover_critical' | 'wind_watch' | 'wind_critical' | 'rain_watch' | 'stale'
  | 'test' | 'inbound_ok' | 'inbound_error';

export interface SmsParams {
  cage?: number;
  value?: number;
  delta?: number;
  hours?: number;
  low?: boolean;
  /** Pre-formatted summary for the inbound confirmation, e.g. "OKS 5.2 JOTO 27.5". */
  summary?: string;
}

const f1 = (n: number | undefined) => (n === undefined ? '-' : n.toFixed(1));
const f0 = (n: number | undefined) => (n === undefined ? '-' : String(Math.round(n)));

type Fn = (p: SmsParams) => string;
const T: Record<Lang, Record<SmsTemplateId, Fn>> = {
  sw: {
    do_watch: (p) => `Tahadhari Kizimba ${p.cage}: oksijeni ${f1(p.value)} mg/L (chini kidogo). Lisha nusu ya chakula. Angalia tena baada ya saa 1.`,
    do_critical: (p) => `Tahadhari Kizimba ${p.cage}: oksijeni ${f1(p.value)} mg/L (chini). Acha kulisha. Angalia tena baada ya saa 1.`,
    temp_watch: (p) => `Tahadhari Kizimba ${p.cage}: joto la maji ${f1(p.value)} C (${p.low ? 'chini' : 'juu'}). Pima tena baada ya saa 1.`,
    temp_critical: (p) => `Tahadhari Kizimba ${p.cage}: joto la maji ${f1(p.value)} C (${p.low ? 'chini sana' : 'juu sana'}). Angalia samaki na upime tena baada ya saa 1.`,
    ph_watch: (p) => `Tahadhari Kizimba ${p.cage}: pH ${f1(p.value)} (nje kidogo ya kiwango). Pima tena kwa sampuli mpya.`,
    ph_critical: (p) => `Tahadhari Kizimba ${p.cage}: pH ${f1(p.value)} (nje ya kiwango). Pima tena kwa sampuli mpya na mwambie afisa ugani.`,
    turnover_watch: (p) => `Tahadhari Kizimba ${p.cage}: hatari ya maji kupinduka. Tofauti ya joto ${f1(p.delta)} C. Acha kulisha; pima oksijeni kila saa.`,
    turnover_critical: (p) => `Hatari Kizimba ${p.cage}: maji yanaweza kupinduka, oksijeni ${f1(p.value)} mg/L. Acha kulisha; pima oksijeni kila saa.`,
    wind_watch: (p) => `Tahadhari: upepo mkali unatarajiwa (${f0(p.value)} km/h). Kagua kamba na nyavu za vizimba.`,
    wind_critical: (p) => `Hatari: upepo mkali sana unatarajiwa (${f0(p.value)} km/h). Linda vizimba na acha kulisha.`,
    rain_watch: (p) => `Tahadhari: mvua kubwa inatarajiwa (${f0(p.value)} mm). Kagua vizimba na uangalie maji.`,
    stale: (p) => `Kizimba ${p.cage}: hakuna kipimo kwa saa ${f0(p.hours)}. Tafadhali rekodi kipimo leo.`,
    test: () => `Jaribio la ${BRAND.name}: SMS zinafanya kazi. Hakuna hatua inayohitajika.`,
    inbound_ok: (p) => `Imepokelewa Kizimba ${p.cage}: ${p.summary}. Asante.`,
    inbound_error: () => 'Haikueleweka. Tuma: RIPOTI K3 OKS 5.2 JOTO 27.5 PH 7.4',
  },
  en: {
    do_watch: (p) => `Alert Cage ${p.cage}: oxygen ${f1(p.value)} mg/L (a little low). Feed half rations. Check again in 1 hour.`,
    do_critical: (p) => `Alert Cage ${p.cage}: oxygen ${f1(p.value)} mg/L (low). Stop feeding. Check again in 1 hour.`,
    temp_watch: (p) => `Alert Cage ${p.cage}: water temperature ${f1(p.value)} C (${p.low ? 'low' : 'high'}). Check again in 1 hour.`,
    temp_critical: (p) => `Alert Cage ${p.cage}: water temperature ${f1(p.value)} C (${p.low ? 'very low' : 'very high'}). Check the fish and measure again in 1 hour.`,
    ph_watch: (p) => `Alert Cage ${p.cage}: pH ${f1(p.value)} (a little outside range). Measure again with a fresh sample.`,
    ph_critical: (p) => `Alert Cage ${p.cage}: pH ${f1(p.value)} (outside range). Measure again with a fresh sample and tell your extension officer.`,
    turnover_watch: (p) => `Alert Cage ${p.cage}: turnover risk. Surface and deep water differ by ${f1(p.delta)} C. Stop feeding; check oxygen every hour.`,
    turnover_critical: (p) => `Danger Cage ${p.cage}: water may turn over, oxygen ${f1(p.value)} mg/L. Stop feeding; check oxygen every hour.`,
    wind_watch: (p) => `Alert: strong wind forecast (${f0(p.value)} km/h). Check moorings and nets on your cages.`,
    wind_critical: (p) => `Danger: very strong wind forecast (${f0(p.value)} km/h). Secure your cages and stop feeding.`,
    rain_watch: (p) => `Alert: heavy rain forecast (${f0(p.value)} mm). Check your cages and watch the water.`,
    stale: (p) => `Cage ${p.cage}: no reading for ${f0(p.hours)} hours. Please record a reading today.`,
    test: () => `${BRAND.name} test: SMS is working. No action needed.`,
    inbound_ok: (p) => `Received Cage ${p.cage}: ${p.summary}. Thank you.`,
    inbound_error: () => 'Not understood. Send: REPORT C3 DO 5.2 T 27.5 PH 7.4',
  },
};

export function renderSms(id: SmsTemplateId, lang: Lang, params: SmsParams = {}): string {
  return T[lang][id](params);
}
export const ALL_TEMPLATE_IDS = Object.keys(T.en) as SmsTemplateId[];

export function templateForAlert(a: Pick<Alert, 'rule' | 'severity'>): SmsTemplateId {
  switch (a.rule) {
    case 'do': return a.severity === 'critical' ? 'do_critical' : 'do_watch';
    case 'temp': return a.severity === 'critical' ? 'temp_critical' : 'temp_watch';
    case 'ph': return a.severity === 'critical' ? 'ph_critical' : 'ph_watch';
    case 'turnover': return a.severity === 'critical' ? 'turnover_critical' : 'turnover_watch';
    case 'wind': return a.severity === 'critical' ? 'wind_critical' : 'wind_watch';
    case 'rain': return 'rain_watch';
    case 'stale': return 'stale';
  }
}
export function paramsForAlert(a: Alert, cageNumber?: number): SmsParams {
  return { cage: cageNumber, value: a.params.value, delta: a.params.deltaC, hours: a.params.hours, low: a.params.limitKind === 'low' };
}
