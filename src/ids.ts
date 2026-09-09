import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Prefixed, human-readable identifier — `dep_x7k2…`. Ids appear in URLs and
 * responses, so a typed prefix makes a misrouted id obvious at a glance.
 */
export function newId(prefix: string, length = 16): string {
  const bytes = randomBytes(length);
  let body = '';
  for (let i = 0; i < length; i += 1) {
    // Modulo bias over a 36-character alphabet is irrelevant for an opaque
    // identifier; secrets use full-entropy encoding instead (newApiKeySecret).
    body += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  }
  return `${prefix}_${body}`;
}

/** 192 bits of entropy, base64url-encoded. */
export function newApiKeySecret(): string {
  return `sk_${randomBytes(24).toString('base64url')}`;
}

/** The non-secret leading fragment, safe to store in logs and show in responses. */
export function keyPrefix(secret: string): string {
  return secret.slice(0, 11);
}
