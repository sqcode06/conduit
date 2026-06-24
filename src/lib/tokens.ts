// 256-bit capability tokens. The raw token is the only credential and is shown
// to the operator exactly once; we persist only its SHA-256 hash, so a database
// leak cannot reconstruct a working link.

const TOKEN_BYTES = 32; // 256-bit

export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function hashToken(rawToken: string): Promise<string> {
  const data = new TextEncoder().encode(rawToken);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// URL-path-safe base64 (RFC 4648 §5), no padding.
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
