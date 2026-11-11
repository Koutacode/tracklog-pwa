const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isOpsTokenHash(value: string | undefined | null): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value.trim().toLowerCase());
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

/** Compare a presented bearer token with the stored SHA-256 hex digest. */
export async function opsTokenMatches(presented: string, expectedHash: string): Promise<boolean> {
  const normalized = expectedHash.trim().toLowerCase();
  if (!SHA256_HEX.test(normalized)) return false;
  if (presented.length < 16 || presented.length > 256) return false;
  const actual = await sha256Hex(presented);
  return timingSafeEqual(actual, normalized);
}

export function readBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  return match?.[1] ?? null;
}
