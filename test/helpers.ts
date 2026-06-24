import { env } from 'cloudflare:test';
import { hashToken, nowSeconds } from '../src/lib/tokens';

const enc = new TextEncoder();

// Seed a file directly into R2 + D1 (bypasses the upload endpoint for control).
export async function seedFile(
  opts: { body?: Uint8Array | string; filename?: string; contentType?: string } = {},
) {
  const id = crypto.randomUUID();
  const r2Key = `blobs/${id}`;
  const body = typeof opts.body === 'string' ? enc.encode(opts.body) : (opts.body ?? enc.encode('hello conduit'));
  const filename = opts.filename ?? 'file.bin';
  const contentType = opts.contentType ?? 'text/plain;charset=utf-8';
  await env.BUCKET.put(r2Key, body, { httpMetadata: { contentType }, customMetadata: { filename } });
  await env.DB.prepare(
    `INSERT INTO files (id, r2_key, filename, content_type, size_bytes, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(id, r2Key, filename, contentType, body.byteLength, nowSeconds())
    .run();
  return { id, r2Key, size: body.byteLength };
}

// Seed a link with a known raw token so the test can drive /d/:token. Lets the
// test set otherwise-unmintable states (already expired, revoked, pre-consumed).
export async function seedLink(
  fileId: string,
  rawToken: string,
  opts: {
    maxDownloads?: number;
    graceSeconds?: number;
    expiresAt?: number | null;
    revokedAt?: number | null;
    downloadCount?: number;
    firstDownloadAt?: number | null;
  } = {},
) {
  const id = crypto.randomUUID();
  const tokenHash = await hashToken(rawToken);
  await env.DB.prepare(
    `INSERT INTO links (id, file_id, token_hash, max_downloads, download_count, grace_seconds,
       first_download_at, expires_at, revoked_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      id,
      fileId,
      tokenHash,
      opts.maxDownloads ?? 1,
      opts.downloadCount ?? 0,
      opts.graceSeconds ?? 0,
      opts.firstDownloadAt ?? null,
      opts.expiresAt ?? null,
      opts.revokedAt ?? null,
      nowSeconds(),
    )
    .run();
  return { id, tokenHash };
}

export async function linkRow(tokenHash: string) {
  return env.DB.prepare('SELECT download_count, first_download_at FROM links WHERE token_hash = ?1')
    .bind(tokenHash)
    .first<{ download_count: number; first_download_at: number | null }>();
}

export function readJson<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

// Poll until `fn` returns a truthy value (for waitUntil-deferred audit writes).
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  tries = 25,
  delayMs = 20,
): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('waitFor: condition not met in time');
}
