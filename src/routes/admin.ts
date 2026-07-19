import { Hono } from 'hono';
import type { AppEnv, AppContext } from '../types';
import { requireAccess } from '../lib/access';
import { generateToken, hashToken, nowSeconds } from '../lib/tokens';
import { sanitizeFilename, sanitizeContentType } from '../lib/sanitize';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES, getPartSize, fmtBytes } from '../lib/limits';
import { API_VERSION } from '../lib/api-version';

// Admin API. Every route is gated by Cloudflare Access at the edge AND re-verified
// in-Worker by requireAccess() (deny-by-default). Mounted at /admin/api in index.ts.
export const admin = new Hono<AppEnv>();
admin.use('*', requireAccess());
admin.use('*', async (c, next) => {
  await next();
  c.header('X-Conduit-Api-Version', String(API_VERSION));
});

function isoFromSeconds(s: number): string {
  return new Date(s * 1000).toISOString();
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

interface FileListRow {
  id: string;
  name: string;
  size: number;
  created_at: number;
  link_count: number;
}

interface FileCursor {
  createdAt: number;
  id: string;
}

const FILE_ID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function parseFileCursor(value: string): FileCursor | null {
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const createdAt = Number(value.slice(0, separator));
  const id = value.slice(separator + 1);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !FILE_ID_RE.test(id)) return null;
  return { createdAt, id };
}

function formatFileCursor(row: FileListRow): string {
  return `${row.created_at}:${row.id}`;
}

// Total bytes currently stored (system of record for the 10 GiB cap).
async function usedBytes(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM files')
    .first<{ total: number }>();
  return row?.total ?? 0;
}

// R2 keys are always server-generated as blobs/<uuid>; reject anything else so a
// client can never steer a part/complete/abort at an arbitrary object.
function validKey(key: unknown): key is string {
  return typeof key === 'string' && /^blobs\/[0-9a-f-]{36}$/.test(key);
}

// Atomic insert that also enforces the total-storage cap: the row lands only if
// it keeps SUM(size_bytes) within MAX_TOTAL_BYTES. Because D1 serializes writes,
// this single conditional statement closes the check-then-insert race between
// concurrent uploads. Returns null if the cap would be exceeded (the caller then
// deletes the already-written R2 object).
async function insertFile(
  c: AppContext,
  id: string,
  key: string,
  filename: string,
  contentType: string,
  size: number,
): Promise<{ id: string; name: string; size: number; created_at: string } | null> {
  const now = nowSeconds();
  const res = await c.env.DB.prepare(
    `INSERT INTO files (id, r2_key, filename, content_type, size_bytes, created_at, created_by)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE (SELECT COALESCE(SUM(size_bytes), 0) FROM files) + ?5 <= ?8`,
  )
    .bind(id, key, filename, contentType, size, now, c.get('adminEmail'), MAX_TOTAL_BYTES)
    .run();
  if (!res.meta.changes) return null;
  return { id, name: filename, size, created_at: isoFromSeconds(now) };
}

// GET /admin/api/whoami — identity check for the CLI (login / doctor).
admin.get('/whoami', (c) =>
  c.json({
    ok: true,
    identity: c.get('adminEmail'),
    via_bypass: c.get('adminViaBypass'),
    api_version: API_VERSION,
  }),
);

// GET /admin/api/usage — storage usage + the limits (drives client UX).
admin.get('/usage', async (c) => {
  const used = await usedBytes(c.env.DB);
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM files').first<{ n: number }>();
  return c.json({
    used_bytes: used,
    total_limit: MAX_TOTAL_BYTES,
    file_limit: MAX_FILE_BYTES,
    part_size: getPartSize(c.env),
    count: row?.n ?? 0,
  });
});

// POST /admin/api/files — single-request upload (for files up to one part).
admin.post('/files', async (c) => {
  const filename = sanitizeFilename(c.req.header('X-Filename'));
  const contentType = sanitizeContentType(c.req.header('Content-Type'));
  const declaredLen = Number(c.req.header('Content-Length') || '0');
  if (Number.isFinite(declaredLen) && declaredLen > MAX_FILE_BYTES) {
    return c.json({ error: `File exceeds the ${fmtBytes(MAX_FILE_BYTES)} per-file limit` }, 413);
  }
  const used = await usedBytes(c.env.DB);
  if (Number.isFinite(declaredLen) && declaredLen > 0 && used + declaredLen > MAX_TOTAL_BYTES) {
    return c.json({ error: `Not enough storage — ${fmtBytes(MAX_TOTAL_BYTES - used)} free` }, 413);
  }
  if (!c.req.raw.body) return c.json({ error: 'Empty request body' }, 400);

  const id = crypto.randomUUID();
  const r2Key = `blobs/${id}`;
  const put = await c.env.BUCKET.put(r2Key, c.req.raw.body, {
    httpMetadata: { contentType },
    customMetadata: { filename },
  });
  if (!put) return c.json({ error: 'Upload failed' }, 500);

  // Per-file cap against the ACTUAL size, even if Content-Length lied.
  if (put.size > MAX_FILE_BYTES) {
    await c.env.BUCKET.delete(r2Key);
    return c.json({ error: `File exceeds the ${fmtBytes(MAX_FILE_BYTES)} per-file limit` }, 413);
  }
  // Total cap is enforced atomically inside insertFile; clean up if it rejects.
  const file = await insertFile(c, id, r2Key, filename, contentType, put.size);
  if (!file) {
    await c.env.BUCKET.delete(r2Key);
    return c.json({ error: 'Storage limit exceeded' }, 413);
  }
  return c.json(file, 201);
});

// POST /admin/api/uploads — begin a multipart upload for a large file.
admin.post('/uploads', async (c) => {
  const body = await c.req
    .json<{ filename?: string; content_type?: string; size?: number }>()
    .catch(() => ({}) as Record<string, never>);
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) return c.json({ error: 'invalid size' }, 400);
  if (size > MAX_FILE_BYTES) {
    return c.json({ error: `File exceeds the ${fmtBytes(MAX_FILE_BYTES)} per-file limit` }, 413);
  }
  const used = await usedBytes(c.env.DB);
  if (used + size > MAX_TOTAL_BYTES) {
    return c.json({ error: `Not enough storage — ${fmtBytes(MAX_TOTAL_BYTES - used)} free` }, 413);
  }

  const filename = sanitizeFilename(body.filename);
  const contentType = sanitizeContentType(body.content_type);
  const id = crypto.randomUUID();
  const r2Key = `blobs/${id}`;
  const upload = await c.env.BUCKET.createMultipartUpload(r2Key, {
    httpMetadata: { contentType },
    customMetadata: { filename },
  });

  return c.json(
    {
      file_id: id,
      key: r2Key,
      upload_id: upload.uploadId,
      part_size: getPartSize(c.env),
      filename,
      content_type: contentType,
    },
    201,
  );
});

// PUT /admin/api/uploads/parts?key=&upload_id=&part= — stream one part into R2.
admin.put('/uploads/parts', async (c) => {
  const key = c.req.query('key');
  const uploadId = c.req.query('upload_id');
  const partNumber = Number(c.req.query('part'));
  if (!validKey(key) || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
    return c.json({ error: 'bad part request' }, 400);
  }
  if (!c.req.raw.body) return c.json({ error: 'empty part body' }, 400);

  const mp = c.env.BUCKET.resumeMultipartUpload(key, uploadId);
  try {
    const part = await mp.uploadPart(partNumber, c.req.raw.body);
    return c.json({ part_number: part.partNumber, etag: part.etag });
  } catch (e) {
    return c.json({ error: `part upload failed: ${(e as Error).message}` }, 400);
  }
});

// POST /admin/api/uploads/complete — finalize a multipart upload.
admin.post('/uploads/complete', async (c) => {
  const body = await c.req
    .json<{
      file_id?: string;
      key?: string;
      upload_id?: string;
      filename?: string;
      content_type?: string;
      parts?: Array<{ part_number?: number; etag?: string }>;
    }>()
    .catch(() => ({}) as Record<string, never>);

  if (
    !validKey(body.key) ||
    !body.upload_id ||
    !body.file_id ||
    body.key !== `blobs/${body.file_id}` ||
    !Array.isArray(body.parts) ||
    body.parts.length === 0
  ) {
    return c.json({ error: 'bad complete request' }, 400);
  }

  // Validate parts at the boundary: positive integers, present etags, no dups.
  const seen = new Set<number>();
  for (const p of body.parts) {
    const pn = Number(p.part_number);
    if (!Number.isInteger(pn) || pn < 1 || !p.etag || seen.has(pn)) {
      return c.json({ error: 'invalid parts' }, 400);
    }
    seen.add(pn);
  }
  const uploaded = body.parts
    .map((p) => ({ partNumber: Number(p.part_number), etag: String(p.etag) }))
    .sort((a, b) => a.partNumber - b.partNumber);

  const mp = c.env.BUCKET.resumeMultipartUpload(body.key, body.upload_id);
  let obj;
  try {
    obj = await mp.complete(uploaded);
  } catch (e) {
    return c.json({ error: `complete failed: ${(e as Error).message}` }, 400);
  }

  if (obj.size > MAX_FILE_BYTES) {
    await c.env.BUCKET.delete(body.key);
    return c.json({ error: `File exceeds the ${fmtBytes(MAX_FILE_BYTES)} per-file limit` }, 413);
  }
  const filename = sanitizeFilename(body.filename);
  const contentType = sanitizeContentType(body.content_type);
  // Total cap is enforced atomically inside insertFile; clean up if it rejects.
  const file = await insertFile(c, body.file_id, body.key, filename, contentType, obj.size);
  if (!file) {
    await c.env.BUCKET.delete(body.key);
    return c.json({ error: 'Storage limit exceeded' }, 413);
  }
  return c.json(file, 201);
});

// POST /admin/api/uploads/abort — discard an in-progress multipart upload.
admin.post('/uploads/abort', async (c) => {
  const body = await c.req
    .json<{ key?: string; upload_id?: string }>()
    .catch(() => ({}) as Record<string, never>);
  if (!validKey(body.key) || !body.upload_id) return c.json({ error: 'bad abort request' }, 400);
  try {
    await c.env.BUCKET.resumeMultipartUpload(body.key, body.upload_id).abort();
  } catch {
    /* best effort — an unknown id is fine */
  }
  return c.body(null, 204);
});

// GET /admin/api/files — list with per-file live link count.
admin.get('/files', async (c) => {
  const limit = clampInt(c.req.query('limit'), 500, 1, 1000);
  const rawCursor = c.req.query('cursor');
  const cursor = rawCursor === undefined ? null : parseFileCursor(rawCursor);
  if (rawCursor !== undefined && !cursor) return c.json({ error: 'invalid file cursor' }, 400);

  const select = `SELECT f.id, f.filename AS name, f.size_bytes AS size, f.created_at,
                          (SELECT COUNT(*) FROM links l WHERE l.file_id = f.id) AS link_count
                   FROM files f`;
  const queryLimit = limit + 1;
  const statement = cursor
    ? c.env.DB.prepare(
        `${select}
         WHERE f.created_at < ?1 OR (f.created_at = ?1 AND f.id < ?2)
         ORDER BY f.created_at DESC, f.id DESC
         LIMIT ?3`,
      ).bind(cursor.createdAt, cursor.id, queryLimit)
    : c.env.DB.prepare(
        `${select}
         ORDER BY f.created_at DESC, f.id DESC
         LIMIT ?1`,
      ).bind(queryLimit);

  const { results } = await statement.all<FileListRow>();
  const page = results.slice(0, limit);
  const files = page.map((f) => ({ ...f, created_at: isoFromSeconds(f.created_at) }));
  const last = page.at(-1);
  const next_cursor = results.length > limit && last ? formatFileCursor(last) : null;
  return c.json({ files, next_cursor });
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
