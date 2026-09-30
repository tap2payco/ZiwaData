import { useEffect, useState } from 'react';
import type { Role } from './data/prefs';

export interface Route {
  role: Role;
  page: string;
  params: string[];
}
const ROLES: Role[] = ['farmer', 'lender', 'extension'];
export const DEFAULT_PAGE: Record<Role, string> = { farmer: 'home', lender: 'portfolio', extension: 'farms' };

export function parseHash(hash: string, fallbackRole: Role): Route {
  const parts = hash.replace(/^#\/?/, '').split('?')[0]!.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0 || parts[0] === 'landing') {
    return { role: fallbackRole, page: 'landing', params: [] };
  }
  if (parts[0] === 'auth') {
    return { role: fallbackRole, page: 'auth', params: parts.slice(1) };
  }
  const role = (ROLES as string[]).includes(parts[0] ?? '') ? (parts[0] as Role) : fallbackRole;
  const rest = (ROLES as string[]).includes(parts[0] ?? '') ? parts.slice(1) : parts;
  return { role, page: rest[0] ?? DEFAULT_PAGE[role], params: rest.slice(1) };
}
export const href = (role: Role, page: string, ...params: string[]) => `#/${role}/${[page, ...params.map(encodeURIComponent)].join('/')}`;
export function navigate(role: Role, page: string, ...params: string[]) {
  window.location.hash = href(role, page, ...params).slice(1);
}
export function useHash(): string {
  const [h, setH] = useState(() => window.location.hash);
  useEffect(() => {
    const f = () => setH(window.location.hash);
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return h;
}
