import type { Lang } from './types';

/** Tanzania is UTC+3 all year (East Africa Time, no daylight saving). Fixed offset keeps output deterministic. */
export const EAT_OFFSET_MS = 3 * 3600_000;
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

const MONTHS: Record<Lang, string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  sw: ['Jan', 'Feb', 'Mac', 'Apr', 'Mei', 'Jun', 'Jul', 'Ago', 'Sep', 'Okt', 'Nov', 'Des'],
};

const pad = (n: number) => String(n).padStart(2, '0');
const eat = (ms: number) => new Date(ms + EAT_OFFSET_MS);

/** "29 Sep 2026" */
export function formatDate(ms: number, lang: Lang = 'en'): string {
  const d = eat(ms);
  return `${d.getUTCDate()} ${MONTHS[lang][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
/** "09:10" (24 h, East Africa Time) */
export function formatTime(ms: number): string {
  const d = eat(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
/** "29 Sep 2026 09:10" */
export function formatDateTime(ms: number, lang: Lang = 'en'): string {
  return `${formatDate(ms, lang)} ${formatTime(ms)}`;
}
/** "29 Sep" (chart axis) */
export function formatDayMonth(ms: number, lang: Lang = 'en'): string {
  const d = eat(ms);
  return `${d.getUTCDate()} ${MONTHS[lang][d.getUTCMonth()]}`;
}
/** East Africa calendar day key, "2026-09-29". */
export function dayKey(ms: number): string {
  const d = eat(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export function dayKeyToMs(key: string): number {
  // Midnight EAT of that day, as UTC ms.
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!) - EAT_OFFSET_MS;
}
/** Start of the EAT day containing ms. */
export function startOfDay(ms: number): number {
  return dayKeyToMs(dayKey(ms));
}
/** Money as `TZS 300,000`. */
export function formatMoney(n: number): string {
  return `TZS ${Math.round(n).toLocaleString('en-US')}`;
}
/** Fixed decimals with a dot, never locale-dependent. Null/undefined gives an em dash (No reading). */
export function num(v: number | null | undefined, dp = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toFixed(dp);
}
export function thousands(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
/** Whole minutes/hours/days between two instants, for "2 h ago" style text. */
export function ageParts(ts: number, now: number): { unit: 'min' | 'h' | 'd'; n: number } {
  const diff = Math.max(0, now - ts);
  if (diff < HOUR_MS) return { unit: 'min', n: Math.max(1, Math.round(diff / 60_000)) };
  if (diff < DAY_MS) return { unit: 'h', n: Math.round(diff / HOUR_MS) };
  return { unit: 'd', n: Math.floor(diff / DAY_MS) };
}
