import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { consumeLink, peekLink, peekForHead, type DenyReason } from '../lib/consume';
import { buildDownloadResponse, headResponse } from '../lib/stream';
import { recordDownload } from '../lib/audit';
import { unavailableResponse } from '../lib/unavailable';

// Public, token-gated download. NOT behind Cloudflare Access. The token in the URL
// is the sole credential: valid -> 200/206 stream from R2; anything else -> the
// neutral unavailable page (never 403/404).
export const download = new Hono<AppEnv>();

function statusForReason(reason: DenyReason): 'spent' | 'expired' | 'denied' {
  if (reason === 'expired') return 'expired';
  if (reason === 'spent') return 'spent';
  return 'denied';
}

interface FileRow {
  r2_key: string;
  filename: string;
  content_type: string;
}

async function loadFile(db: D1Database, fileId: string): Promise<FileRow | null> {
  return db
    .prepare('SELECT r2_key, filename, content_type FROM files WHERE id = ?1')
    .bind(fileId)
    .first<FileRow>();
}

download.on(['GET', 'HEAD'], '/d/:token', async (c) => {
  const token = c.req.param('token');
  const db = c.env.DB;

  // HEAD never consumes the link, and is answered from a single D1 query with no
  // R2 access — so HEAD response timing does not reveal whether the token is usable.
  if (c.req.method === 'HEAD') {
    const head = await peekForHead(db, token);
    if (!head.usable) return unavailableResponse();
    return headResponse({ filename: head.filename, contentType: head.contentType }, head.size);
  }

  // GET: atomic authorize-and-consume.
  const result = await consumeLink(db, token);
  if (!result.ok || !result.row) {
    // Classify + audit the denied attempt AFTER responding (in waitUntil). This
    // keeps the response path a single query (consumeLink, which returns null
    // identically whether the token never existed or is dead) — so request timing
    // is not an oracle for link existence. The page is byte-identical regardless.
    c.executionCtx.waitUntil(
      peekLink(db, token).then(({ link, reason }) =>
        recordDownload(c, {
          link_id: link?.id ?? null,
          file_id: link?.file_id ?? null,
          status: statusForReason(reason),
          denied_reason: reason,
        }),
      ),
    );
    return unavailableResponse();
  }

  const row = result.row;
  const file = await loadFile(db, row.file_id);
  if (!file) {
    c.executionCtx.waitUntil(
      recordDownload(c, {
        link_id: row.link_id,
        file_id: row.file_id,
        status: 'denied',
        denied_reason: 'file_record_missing',
      }),
    );
    return unavailableResponse();
  }

  const serve = await buildDownloadResponse(
    c.env.BUCKET,
    file.r2_key,
    { filename: file.filename, contentType: file.content_type },
    c.req.raw,
  );
  if (!serve) {
    c.executionCtx.waitUntil(
      recordDownload(c, {
        link_id: row.link_id,
        file_id: row.file_id,
        status: 'denied',
        denied_reason: 'object_missing',
      }),
    );
    return unavailableResponse();
  }

  c.executionCtx.waitUntil(
    recordDownload(c, {
      link_id: row.link_id,
      file_id: row.file_id,
      status: 'ok',
      range_start: serve.rangeStart,
      range_end: serve.rangeEnd,
      bytes_sent: serve.bytesPlanned,
    }),
  );
  return serve.response;
});
