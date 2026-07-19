import { open, type FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { basename, extname } from 'node:path';
import type { Config } from './config';
import { formatSize } from './util';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly auth = false,
    readonly usage = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  created_at: string;
}

export interface FileRow extends UploadedFile {
  link_count: number;
}

export interface MintResult {
  token: string;
  url: string;
  max_downloads: number;
  grace_seconds: number;
  expires_at: string | null;
}

export interface DownloadRow {
  file_name: string | null;
  ip: string | null;
  country: string | null;
  status: string;
  created_at: string;
}

export interface WhoAmI {
  ok: boolean;
  identity: string;
  via_bypass: boolean;
  api_version: number;
}

export interface MintOptions {
  maxDownloads?: number;
  graceSeconds?: number;
  expiresInSeconds?: number | null;
}

export interface Usage {
  used_bytes: number;
  total_limit: number;
  file_limit: number;
  part_size: number;
  count: number;
}

interface MultipartInit {
  file_id: string;
  key: string;
  upload_id: string;
  part_size: number;
}

export type UploadProgress = (done: number, total: number) => void;

export const SUPPORTED_API_VERSION = '1';

function sameFileSnapshot(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}

export function normalizeEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError('endpoint must be a valid URL', 0, true);
  }

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new ApiError('endpoint must use HTTPS (HTTP is allowed only for local development)', 0, true);
  }
  if (url.username || url.password) {
    throw new ApiError('endpoint must not contain embedded credentials', 0, true);
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new ApiError('endpoint must be an origin only, without a path, query, or fragment', 0, true);
  }
  return url.origin;
}

export class ConduitClient {
  private readonly base: string;
  private readonly origin: string;

  constructor(private readonly cfg: Config) {
    if (!cfg.endpoint) {
      throw new ApiError('No endpoint configured. Run `conduit login`.', 0, true);
    }
    this.origin = normalizeEndpoint(cfg.endpoint);
    if (
      this.origin.startsWith('http:') &&
      (this.cfg.accessClientId || this.cfg.accessClientSecret)
    ) {
      throw new ApiError('Access service tokens may not be sent over HTTP, including loopback', 0, true);
    }
    this.base = this.origin + '/admin/api';
  }

  private buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    // Cloudflare Access service token — validated at the edge, never by the Worker.
    if (this.cfg.accessClientId && this.cfg.accessClientSecret) {
      h['CF-Access-Client-Id'] = this.cfg.accessClientId;
      h['CF-Access-Client-Secret'] = this.cfg.accessClientSecret;
    }
    return h;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        ...init,
        headers: this.buildHeaders(init.headers as Record<string, string>),
        // Never forward Access service-token headers to a redirect target.
        redirect: 'manual',
      });
    } catch (e) {
      throw new ApiError(`cannot reach ${this.base}${path} — ${(e as Error).message}`, 0);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      let accessRedirect = false;
      if (location) {
        try {
          accessRedirect = /(^|\.)cloudflareaccess\.com$/i.test(
            new URL(location, this.base).hostname,
          );
        } catch {
          /* malformed redirect is handled as a generic redirect below */
        }
      }
      if (accessRedirect) {
        throw new ApiError(
          'Cloudflare Access did not accept the service token (it redirected to login). ' +
            'Add a "Service Auth" policy that includes this token to the Access application, ' +
            'and double-check the endpoint.',
          res.status,
          true,
        );
      }
      throw new ApiError('endpoint returned an unexpected redirect; check the configured origin', res.status);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ApiError(
        'access denied — check your service token and that the Access policy allows it',
        res.status,
        true,
      );
    }
    if (!res.ok) {
      let detail = res.statusText;
      try {
        detail = ((await res.json()) as { error?: string }).error ?? detail;
      } catch {
        /* non-JSON body */
      }
      throw new ApiError(detail, res.status);
    }
    if ((res.headers.get('content-type') || '').includes('text/html')) {
      throw new ApiError(
        'expected JSON but got an HTML page — usually the Cloudflare Access login, ' +
          'meaning the service token was not accepted. Check the endpoint and the ' +
          'Access "Service Auth" policy.',
        res.status,
        true,
      );
    }
    const apiVersion = res.headers.get('X-Conduit-Api-Version');
    if (apiVersion !== SUPPORTED_API_VERSION) {
      throw new ApiError(
        `incompatible CONDUIT server API (expected ${SUPPORTED_API_VERSION}, got ${apiVersion ?? 'none'})`,
        res.status,
      );
    }
    return res;
  }

  async whoami(): Promise<WhoAmI> {
    const res = await this.request('/whoami');
    const value = (await res.json().catch(() => null)) as Partial<WhoAmI> | null;
    if (
      !value ||
      value.ok !== true ||
      typeof value.identity !== 'string' ||
      !value.identity.trim() ||
      typeof value.via_bypass !== 'boolean' ||
      value.api_version !== Number(SUPPORTED_API_VERSION)
    ) {
      throw new ApiError('CONDUIT server returned an invalid identity response', res.status);
    }
    return value as WhoAmI;
  }

  async listFiles(): Promise<FileRow[]> {
    const { files } = (await (await this.request('/files')).json()) as { files: FileRow[] };
    return files;
  }

  async listDownloads(limit = 25): Promise<DownloadRow[]> {
    const data = (await (await this.request(`/downloads?limit=${limit}`)).json()) as {
      downloads: DownloadRow[];
    };
    return data.downloads;
  }

  async deleteFile(id: string): Promise<void> {
    await this.request(`/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async mintLink(fileId: string, opts: MintOptions): Promise<MintResult> {
    const res = await this.request(`/files/${encodeURIComponent(fileId)}/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        max_downloads: opts.maxDownloads ?? 1,
        grace_seconds: opts.graceSeconds ?? 0,
        expires_in_seconds: opts.expiresInSeconds ?? null,
      }),
    });
    const value = (await res.json().catch(() => null)) as Partial<MintResult> | null;
    if (
      !value ||
      typeof value.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
      typeof value.url !== 'string' ||
      !Number.isInteger(value.max_downloads) ||
      !Number.isInteger(value.grace_seconds) ||
      (value.expires_at !== null && typeof value.expires_at !== 'string')
    ) {
      throw new ApiError('CONDUIT server returned an invalid link response', res.status);
    }
    let link: URL;
    try {
      link = new URL(value.url);
    } catch {
      throw new ApiError('CONDUIT server returned an invalid link URL', res.status);
    }
    if (
      link.origin !== this.origin ||
      link.pathname !== `/d/${value.token}` ||
      link.search ||
      link.hash
    ) {
      throw new ApiError('CONDUIT server returned a link outside the configured origin', res.status);
    }
    return value as MintResult;
  }

  async usage(): Promise<Usage> {
    const res = await this.request('/usage');
    const value = (await res.json().catch(() => null)) as Partial<Usage> | null;
    const usedBytes = value?.used_bytes;
    const totalLimit = value?.total_limit;
    const fileLimit = value?.file_limit;
    const partSize = value?.part_size;
    const count = value?.count;
    if (
      typeof usedBytes !== 'number' ||
      !Number.isSafeInteger(usedBytes) ||
      usedBytes < 0 ||
      typeof totalLimit !== 'number' ||
      !Number.isSafeInteger(totalLimit) ||
      totalLimit < usedBytes ||
      typeof fileLimit !== 'number' ||
      !Number.isSafeInteger(fileLimit) ||
      fileLimit < 1 ||
      typeof partSize !== 'number' ||
      !Number.isSafeInteger(partSize) ||
      partSize < 5 * 1024 * 1024 ||
      partSize > fileLimit ||
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      throw new ApiError('CONDUIT server returned invalid storage limits', res.status);
    }
    return {
      used_bytes: usedBytes,
      total_limit: totalLimit,
      file_limit: fileLimit,
      part_size: partSize,
      count,
    };
  }

  // Routes to a single PUT for small files, or chunked R2 multipart for large ones.
  async upload(path: string, onProgress?: UploadProgress): Promise<UploadedFile> {
    const fh = await open(path, 'r');
    try {
      const initialSnapshot = await fh.stat({ bigint: true });
      if (!initialSnapshot.isFile() || initialSnapshot.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new ApiError('upload path must be a regular file', 0, false, true);
      }
      const size = Number(initialSnapshot.size);
      const usage = await this.usage();
      if (size > usage.file_limit) {
        throw new ApiError(
          `file is ${formatSize(size)}, over the ${formatSize(usage.file_limit)} per-file limit`,
          0,
          false,
          true,
        );
      }
      if (usage.used_bytes + size > usage.total_limit) {
        throw new ApiError(
          `not enough storage — ${formatSize(usage.total_limit - usage.used_bytes)} free`,
          0,
          false,
          true,
        );
      }
      if (size <= usage.part_size) {
        return await this.uploadSingle(path, fh, initialSnapshot);
      }
      return await this.uploadMultipart(
        path,
        size,
        usage.part_size,
        fh,
        initialSnapshot,
        onProgress,
      );
    } finally {
      await fh.close();
    }
  }

  private async uploadSingle(
    path: string,
    fh: FileHandle,
    initialSnapshot: BigIntStats,
  ): Promise<UploadedFile> {
    const name = basename(path);
    const data = await fh.readFile();
    const finalSnapshot = await fh.stat({ bigint: true });
    if (
      BigInt(data.byteLength) !== initialSnapshot.size ||
      !sameFileSnapshot(initialSnapshot, finalSnapshot)
    ) {
      throw new ApiError('file changed while it was being uploaded', 0);
    }
    const res = await this.request('/files', {
      method: 'POST',
      headers: { 'Content-Type': mimeFor(name), 'X-Filename': encodeURIComponent(name) },
      body: new Uint8Array(data),
    });
    return res.json() as Promise<UploadedFile>;
  }

  private async uploadMultipart(
    path: string,
    size: number,
    fallbackPartSize: number,
    fh: FileHandle,
    initialSnapshot: BigIntStats,
    onProgress?: UploadProgress,
  ): Promise<UploadedFile> {
    const name = basename(path);
    const contentType = mimeFor(name);
    let init: MultipartInit | null = null;
    const parts: Array<{ part_number: number; etag: string }> = [];
    try {
      const initRes = await this.request('/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: name, content_type: contentType, size }),
      });
      const initValue = (await initRes.json().catch(() => null)) as Partial<MultipartInit> | null;
      if (
        !initValue ||
        typeof initValue.file_id !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(initValue.file_id) ||
        typeof initValue.key !== 'string' ||
        initValue.key !== `blobs/${initValue.file_id}` ||
        typeof initValue.upload_id !== 'string' ||
        !initValue.upload_id ||
        typeof initValue.part_size !== 'number' ||
        !Number.isSafeInteger(initValue.part_size) ||
        initValue.part_size < 5 * 1024 * 1024 ||
        initValue.part_size > fallbackPartSize
      ) {
        throw new ApiError('CONDUIT server returned an invalid multipart response', initRes.status);
      }
      init = initValue as MultipartInit;
      const partSize = init.part_size;
      const buf = Buffer.allocUnsafe(partSize);
      let done = 0;
      let partNumber = 1;
      for (let off = 0; off < size; off += partSize) {
        const len = Math.min(partSize, size - off);
        const { bytesRead } = await fh.read(buf, 0, len, off);
        if (bytesRead !== len) throw new ApiError('file changed while it was being uploaded', 0);
        const res = (await (
          await this.request(
            `/uploads/parts?key=${encodeURIComponent(init.key)}` +
              `&upload_id=${encodeURIComponent(init.upload_id)}&part=${partNumber}`,
            { method: 'PUT', body: new Uint8Array(buf.subarray(0, bytesRead)) },
          )
        ).json()) as { part_number: number; etag: string };
        parts.push(res);
        done += bytesRead;
        onProgress?.(done, size);
        partNumber++;
      }
      const finalSnapshot = await fh.stat({ bigint: true });
      if (!sameFileSnapshot(initialSnapshot, finalSnapshot)) {
        throw new ApiError('file changed while it was being uploaded', 0);
      }
      return (await (
        await this.request('/uploads/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file_id: init.file_id,
            key: init.key,
            upload_id: init.upload_id,
            filename: name,
            content_type: contentType,
            parts,
          }),
        })
      ).json()) as UploadedFile;
    } catch (e) {
      if (init) {
        await this.request('/uploads/abort', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: init.key, upload_id: init.upload_id }),
        }).catch(() => {});
      }
      throw e;
    }
  }
}

const MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.html': 'text/html',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function mimeFor(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
}
