import { createHash, randomBytes, randomInt } from 'node:crypto';

/**
 * The secrets behind an anonymous profile, all from node:crypto. Only their SHA-256 hashes
 * are stored, so a copy of the database does not let anyone sign in. These values are never
 * logged and never sent anywhere but to their owner.
 */

/** Crockford base32: no I, L, O or U, so a code read aloud or retyped survives. */
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += BASE32[randomInt(BASE32.length)];
  return out;
}

/** A public profile id: 16 characters, 80 random bits. */
export function newProfileId(): string {
  return base32(16);
}

export function isProfileId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[0-9A-HJKMNP-TV-Z]{16}$/.test(raw);
}

/** A browser's session token (the cookie value): 256 random bits. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** A session token as the cookie carries it: 43 base64url characters. */
export function isSessionToken(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw);
}

/** A recovery code: 20 characters (100 bits), shown in groups of five. */
export function newRecoveryCode(): string {
  return base32(20).match(/.{5}/g)!.join('-');
}

/**
 * A typed recovery code in its canonical form, or null. Case, spaces and dashes do not matter,
 * and the letters people confuse with digits are read as those digits (O as 0, I and L as 1).
 */
export function normalizeRecoveryCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (code.length !== 20) return null;
  for (const ch of code) if (!BASE32.includes(ch)) return null;
  return code;
}

/** What the database keeps instead of a secret. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** A single-use pass that binds the next room seat to a profile (see RankingService). */
export function newTicket(): string {
  return randomBytes(24).toString('base64url');
}
