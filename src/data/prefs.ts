import type { Lang } from '../core/types';

export type ThemeChoice = 'auto' | 'light' | 'dark' | 'sun';
export type Role = 'farmer' | 'lender' | 'extension';
const get = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } };

export const loadLang = (): Lang => (get('app.lang') === 'en' ? 'en' : 'sw'); // Swahili by default
export const saveLang = (l: Lang) => set('app.lang', l);
export const loadTheme = (): ThemeChoice => { const v = get('app.theme'); return v === 'light' || v === 'dark' || v === 'sun' ? v : 'auto'; };
export function applyTheme(t: ThemeChoice) {
  const resolved = t === 'auto' ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t;
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-choice', t);
}
export const saveTheme = (t: ThemeChoice) => { set('app.theme', t); applyTheme(t); };
export const loadRole = (): Role => { const v = get('app.role'); return v === 'lender' || v === 'extension' ? v : 'farmer'; };
export const saveRole = (r: Role) => set('app.role', r);
