import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireAccess } from '../lib/access';
import { generateToken, hashToken, nowSeconds } from '../lib/tokens';
import { sanitizeFilename, sanitizeContentType } from '../lib/sanitize';

// Admin API. Every route is gated by Cloudflare Access at the edge AND re-verified
// in-Worker by requireAccess() (deny-by-default). Mounted at /admin/api in index.ts.
export const admin = new Hono<AppEnv>();
admin.use('*', requireAccess());

// Cloudflare Free/Pro cap a Worker request body at 100 MB; this is the single-PUT
// slice limit. Larger files would need R2 multipart upload (a later slice).
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function isoFromSeconds(s: number): string {
  return new Date(s * 1000).toISOString();
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// POST /admin/api/files — raw-bytes upload streamed into R2.
admin.post('/files', async (c) => {
  const filename = sanitizeFilename(c.req.header('X-Filename'));
  const contentType = sanitizeContentType(c.req.header('Content-Type'));
  const declaredLen = Number(c.req.header('Content-Length') || '0');
  if (Number.isFinite(declaredLen) && declaredLen > MAX_UPLOAD_BYTES) {
    return c.json({ error: 'File exceeds the 100 MB limit' }, 413);
  }
  if (!c.req.raw.body) return c.json({ error: 'Empty request body' }, 400);

  const id = crypto.randomUUID();
  const r2Key = `blobs/${id}`;
  const put = await c.env.BUCKET.put(r2Key, c.req.raw.body, {
    httpMetadata: { contentType },
    customMetadata: { filename },
  });
  if (!put) return c.json({ error: 'Upload failed' }, 500);

  // Enforce the cap server-side even if Content-Length was absent or lied.
  if (put.size > MAX_UPLOAD_BYTES) {
    await c.env.BUCKET.delete(r2Key);
    return c.json({ error: 'File exceeds the 100 MB limit' }, 413);
  }

  const now = nowSeconds();
  await c.env.DB.prepare(
    `INSERT INTO files (id, r2_key, filename, content_type, size_bytes, created_at, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(id, r2Key, filename, contentType, put.size, now, c.get('adminEmail'))
    .run();

  return c.json({ id, name: filename, size: put.size, created_at: isoFromSeconds(now) }, 201);
});

// GET /admin/api/files — list with per-file live link count.
admin.get('/files', async (c) => {
  const limit = clampInt(c.req.query('limit'), 500, 1, 1000);
  const { results } = await c.env.DB.prepare(
    `SELECT f.id, f.filename AS name, f.size_bytes AS size, f.created_at,
            (SELECT COUNT(*) FROM links l WHERE l.file_id = f.id) AS link_count
     FROM files f
     ORDER BY f.created_at DESC
     LIMIT ?1`,
  )
    .bind(limit)
    .all<{ id: string; name: string; size: number; created_at: number; link_count: number }>();
  const files = results.map((f) => ({ ...f, created_at: isoFromSeconds(f.created_at) }));
  return c.json({ files });
});

// DELETE /admin/api/files/:id — delete the blob and the record (cascades links).
admin.delete('/files/:id', async (c) => {
  const id = c.req.param('id');
  const file = await c.env.DB.prepare('SELECT r2_key FROM files WHERE id = ?1')
    .bind(id)
    .first<{ r2_key: string }>();
  if (!file) return c.json({ error: 'Not found' }, 404);
  await c.env.BUCKET.delete(file.r2_key);
  // Drop the file's links explicitly (D1 does not reliably enforce FK cascade),
  // then the file record — atomically batched so we never orphan one without the
  // other. Deleting the links is what actually revokes every outstanding token.
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM links WHERE file_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM files WHERE id = ?1').bind(id),
  ]);
  return c.body(null, 204);
});

// POST /admin/api/files/:id/links — mint a capability link. The raw token is
// returned exactly once and never stored in the clear.
admin.post('/files/:id/links', async (c) => {
  const fileId = c.req.param('id');
  const file = await c.env.DB.prepare('SELECT id FROM files WHERE id = ?1')
    .bind(fileId)
    .first<{ id: string }>();
  if (!file) return c.json({ error: 'Not found' }, 404);

  const body = await c.req
    .json<{ max_downloads?: number; grace_seconds?: number; expires_in_seconds?: number | null }>()
    .catch(() => ({}) as Record<string, never>);

  const maxDownloads = clampInt(body.max_downloads, 1, 1, 10000);
  const graceSeconds = clampInt(body.grace_seconds, 0, 0, 86400);
  const expiresIn =
    body.expires_in_seconds == null
      ? null
      : clampInt(body.expires_in_seconds, 86400, 1, 60 * 60 * 24 * 365);

  const now = nowSeconds();
  const expiresAt = expiresIn == null ? null : now + expiresIn;
  const rawToken = generateToken();
  const tokenHash = await hashToken(rawToken);
  const linkId = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO links (id, file_id, token_hash, max_downloads, download_count,
       grace_seconds, expires_at, created_at, created_by)
     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8)`,
  )
    .bind(linkId, fileId, tokenHash, maxDownloads, graceSeconds, expiresAt, now, c.get('adminEmail'))
    .run();

  // Build the link from the request origin so dev points at localhost and prod at
  // conduit.sqcode.dev automatically.
  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      token: rawToken,
      url: `${origin}/d/${rawToken}`,
      max_downloads: maxDownloads,
      grace_seconds: graceSeconds,
      expires_at: expiresAt == null ? null : isoFromSeconds(expiresAt),
    },
    201,
  );
});

// GET /admin/api/downloads?limit=25 — recent pull feed for the dashboard.
admin.get('/downloads', async (c) => {
  const limit = clampInt(c.req.query('limit'), 25, 1, 200);
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.ts, d.status, d.ip, d.country, f.filename AS file_name
     FROM downloads d
     LEFT JOIN files f ON f.id = d.file_id
     ORDER BY d.ts DESC, d.id DESC
     LIMIT ?1`,
  )
    .bind(limit)
    .all<{
      id: string;
      ts: number;
      status: string;
      ip: string | null;
      country: string | null;
      file_name: string | null;
    }>();
  const downloads = results.map((d) => ({
    file_name: d.file_name,
    ip: d.ip,
    country: d.country,
    status: d.status,
    created_at: isoFromSeconds(d.ts),
  }));
  return c.json({ downloads });
});
