import { createContext, useContext, useMemo } from 'react';
import type { Lang } from '../core/types';
import en from './en';
import sw from './sw';

export type Key = keyof typeof en;
type Params = Record<string, string | number>;
const dicts: Record<Lang, Record<Key, string>> = { en, sw };

/** t('key', {n: 3}) fills {n}. When params.n is given and `key_one` exists, n === 1 picks the singular. */
export function translate(lang: Lang, key: Key, params?: Params): string {
  let k: string = key;
  if (params && typeof params.n === 'number' && params.n === 1 && `${key}_one` in dicts[lang]) k = `${key}_one`;
  let s = (dicts[lang] as Record<string, string>)[k] ?? (dicts.en as Record<string, string>)[k] ?? k;
  if (params) for (const [p, v] of Object.entries(params)) s = s.split(`{${p}}`).join(String(v));
  return s;
}
export type T = (key: Key, params?: Params) => string;
export const LangContext = createContext<Lang>('sw');
export const useLang = () => useContext(LangContext);
export function useT(): T {
  const lang = useLang();
  return useMemo<T>(() => (key, params) => translate(lang, key, params), [lang]);
}
export const dictionaries = dicts;
