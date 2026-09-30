import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Lang } from '../../src/core/types';

/**
 * Sign-in by phone number plus a one-time code sent over SMS. No passwords.
 *
 * What is stored, and what is not:
 *   - The one-time code is NEVER stored. Only SHA-256(secret + phone + code).
 *   - The session token is NEVER stored. Only SHA-256(secret + token). It exists in the user's cookie.
 *   - Nothing here logs a phone number, a code or a token. Ever.
 * A dump of the database therefore does not let anyone sign in as somebody else.
 *
 * The role lives on the user row and is set by the server. The browser never sends a role and cannot
 * change its own, so no request can promote itself.
 */

export type Role = 'farmer' | 'lender' | 'extension';
export const ROLES: Role[] = ['farmer', 'lender', 'extension'];
export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as string[]).includes(v);

export const AUTH_COOKIE = 'sid';

/** Deliberately conservative: an SMS costs money and a code protects a farmer's record. */
export const AUTH_LIMITS = {
  /** Digits in the code. 6 gives a 1-in-a-million guess against a 5-attempt limit. */
  codeLength: 6,
  /** How long a code is usable. */
  codeTtlMs: 10 * 60_000,
  /** Wrong guesses before the code is dead and a new one must be requested. */
  maxAttempts: 5,
  /** Shortest gap between two code requests for one number. Stops an SMS bill being run up. */
  resendGapMs: 60_000,
  /** Codes one number may request per hour. */
  maxCodesPerHour: 5,
  /** How long a session lasts. Farmers should not be signed out mid-season. */
  sessionTtlMs: 30 * 24 * 3600_000,
  /** How often a session's last-seen time is written back, so every request is not a write. */
  touchEveryMs: 3600_000,
} as const;

/**
 * The server's hashing secret. Set AUTH_SECRET in .env for anything that must survive a restart:
 * without it a random one is generated per boot, which is safe but signs everyone out on every restart.
 */
export function authSecret(env: { AUTH_SECRET?: string }): { secret: string; ephemeral: boolean } {
  const s = env.AUTH_SECRET?.trim();
  return s ? { secret: s, ephemeral: false } : { secret: randomBytes(32).toString('hex'), ephemeral: true };
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const hashCode = (secret: string, phone: string, code: string) => sha256(`${secret}:code:${phone}:${code}`);
export const hashToken = (secret: string, token: string) => sha256(`${secret}:session:${token}`);
export const hashPin = (secret: string, pin: string) => sha256(`${secret}:pin:${pin}`);

/** A 6-digit code from a cryptographic source. Leading zeros are kept: "004321" is a valid code. */
export function generateCode(length = AUTH_LIMITS.codeLength): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String(randomInt(0, 10));
  return out;
}

/** 32 random bytes, hex. Only the user's cookie ever holds this. */
export const generateToken = () => randomBytes(32).toString('hex');

/** Compare two hex hashes without leaking, through timing, how much of them matched. */
export function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/** Only digits, and exactly the expected length. Rejects "12 34 56" and anything with a sign or spaces. */
export const looksLikeCode = (v: unknown): v is string =>
  typeof v === 'string' && new RegExp(`^\\d{${AUTH_LIMITS.codeLength}}$`).test(v);

/**
 * Who gets which role on first sign-in. AUTH_ROLES is "phone:role" pairs, comma separated, for example
 *   AUTH_ROLES=255712345678:lender,255713000000:extension
 * Anyone not listed becomes a farmer. Change a role later with SQL; a user can never change their own.
 */
export function roleForPhone(env: { AUTH_ROLES?: string }, phone: string): Role {
  for (const pair of (env.AUTH_ROLES ?? '').split(',')) {
    const [p, r] = pair.split(':').map((x) => x.trim());
    if (p && p === phone && isRole(r)) return r;
  }
  return 'farmer';
}

/** Sign-in is enforced only when AUTH_REQUIRED is on. Off, the app stays the open demo it is today. */
export const authRequired = (env: { AUTH_REQUIRED?: string }): boolean =>
  ['1', 'true', 'yes', 'on'].includes((env.AUTH_REQUIRED ?? '').trim().toLowerCase());

/** The one-time-code SMS. Fixed template, GSM-7, well under 160 characters, no free text from anywhere. */
export function codeMessage(code: string, lang: Lang, brandName: string): string {
  return lang === 'en'
    ? `${brandName}: your code is ${code}. It expires in 10 minutes. Do not share it.`
    : `${brandName}: msimbo wako ni ${code}. Unaisha baada ya dakika 10. Usimpe mtu.`;
}

export interface SessionCookieOptions {
  secure: boolean;
  maxAgeMs: number;
}
/**
 * httpOnly so script cannot read it; SameSite=Lax so another site cannot make the browser use it;
 * Secure whenever we are not on plain-HTTP localhost. Path=/ so the whole API sees it.
 */
export function sessionCookie(token: string, opts: SessionCookieOptions): string {
  const parts = [
    `${AUTH_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`,
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}
export function clearedCookie(secure: boolean): string {
  const parts = [`${AUTH_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Pull our cookie out of a Cookie header without pulling in a parser. */
export function readCookie(header: string | undefined, name = AUTH_COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
