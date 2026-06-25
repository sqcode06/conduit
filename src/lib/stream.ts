// R2 streaming with correct HTTP Range semantics. We parse Range ourselves
// (R2Object.range is request-shaped and carries no inclusive end), stream the
// object body with zero buffering, and own 200 / 206 / 416 correctness end to
// end — Cloudflare does not add Content-Range for Worker-returned bodies.

export interface FileMeta {
  filename: string;
  contentType: string;
}

export interface ServeResult {
  response: Response;
  status: number; // 200 | 206 | 416
  rangeStart: number | null;
  rangeEnd: number | null; // inclusive
  bytesPlanned: number;
}

type RangeParse =
  | { type: 'full' }
  | { type: 'range'; start: number; end: number } // inclusive end
  | { type: 'unsatisfiable' };

// RFC 7233 single-range. Malformed or multi-range degrades to a full 200 (which
// the spec permits); only a valid-but-out-of-bounds range is 416.
export function parseRange(header: string | null, size: number): RangeParse {
  if (!header) return { type: 'full' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { type: 'full' };
  const startRaw = m[1];
  const endRaw = m[2];
  if (startRaw === '' && endRaw === '') return { type: 'full' };

  if (startRaw === '') {
    // suffix range: final N bytes
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return { type: 'unsatisfiable' };
    if (size === 0) return { type: 'unsatisfiable' };
    return { type: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startRaw);
  if (!Number.isFinite(start)) return { type: 'full' };
  if (size === 0) return { type: 'unsatisfiable' };
  if (start >= size) return { type: 'unsatisfiable' };
  let end = endRaw === '' ? size - 1 : Number(endRaw);
  if (!Number.isFinite(end)) return { type: 'full' };
  if (end < start) return { type: 'full' }; // inverted -> ignore Range
  end = Math.min(end, size - 1); // clamp to EOF
  return { type: 'range', start, end };
}

// attachment; with a sanitized ASCII fallback and an RFC 5987 UTF-8 filename*.
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987(filename)}`;
}

// encodeURIComponent leaves ! ' ( ) * - . _ ~ unescaped; of those ' ( ) * are not
// valid RFC 5987 attr-chars, so escape them too.
export function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function baseHeaders(obj: R2Object, meta: FileMeta): Headers {
  const headers = new Headers();
  headers.set(
    'Content-Type',
    meta.contentType || obj.httpMetadata?.contentType || 'application/octet-stream',
  );
  headers.set('Content-Disposition', contentDisposition(meta.filename));
  headers.set('Accept-Ranges', 'bytes');
  headers.set('ETag', obj.httpEtag);
  headers.set('Last-Modified', obj.uploaded.toUTCString());
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  // Never send the capability token to an external origin via Referer.
  headers.set('Referrer-Policy', 'no-referrer');
  return headers;
}

// HEAD response built from stored metadata only (no R2 round-trip), so HEAD timing
// is independent of whether the object would be fetched.
export function headResponse(meta: FileMeta, size: number): Response {
  const headers = new Headers();
  headers.set('Content-Type', meta.contentType || 'application/octet-stream');
  headers.set('Content-Disposition', contentDisposition(meta.filename));
  headers.set('Content-Length', String(size));
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(null, { status: 200, headers });
}

// Returns null when the R2 object is missing (route renders the unavailable page).
// `request` provides method (GET/HEAD) and the Range header.
export async function buildDownloadResponse(
  bucket: R2Bucket,
  r2Key: string,
  meta: FileMeta,
  request: Request,
): Promise<ServeResult | null> {
  // HEAD: use head() so we never fetch a body and never consume the link.
  if (request.method === 'HEAD') {
    const head = await bucket.head(r2Key);
    if (!head) return null;
    const headers = baseHeaders(head, meta);
    headers.set('Content-Length', String(head.size));
    return {
      response: new Response(null, { status: 200, headers }),
      status: 200,
      rangeStart: null,
      rangeEnd: null,
      bytesPlanned: 0,
    };
  }

  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    const head = await bucket.head(r2Key);
    if (!head) return null;
    const parsed = parseRange(rangeHeader, head.size);

    if (parsed.type === 'unsatisfiable') {
      const headers = new Headers();
      headers.set('Content-Range', `bytes */${head.size}`);
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Content-Length', '0');
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('X-Content-Type-Options', 'nosniff');
      return {
        response: new Response(null, { status: 416, headers }),
        status: 416,
        rangeStart: null,
        rangeEnd: null,
        bytesPlanned: 0,
      };
    }

    if (parsed.type === 'range') {
      const length = parsed.end - parsed.start + 1;
      const obj = await bucket.get(r2Key, { range: { offset: parsed.start, length } });
      if (!obj) return null;
      const headers = baseHeaders(obj, meta);
      headers.set('Content-Range', `bytes ${parsed.start}-${parsed.end}/${head.size}`);
      headers.set('Content-Length', String(length));
      return {
        response: new Response(obj.body, { status: 206, headers }),
        status: 206,
        rangeStart: parsed.start,
        rangeEnd: parsed.end,
        bytesPlanned: length,
      };
    }
    // parsed.type === 'full' falls through to the full 200 below.
  }

  const obj = await bucket.get(r2Key);
  if (!obj) return null;
  const headers = baseHeaders(obj, meta);
  headers.set('Content-Length', String(obj.size));
  // Zero-byte object: obj.body is an empty stream; Response handles it.
  return {
    response: new Response(obj.body, { status: 200, headers }),
    status: 200,
    rangeStart: null,
    rangeEnd: null,
    bytesPlanned: obj.size,
  };
}
