import { readFile, stat, open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Config } from './config';
import { formatSize } from './util';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly auth = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface FileRow {
  id: string;
  name: string;
  size: number;
  created_at: string;
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

export type UploadProgress = (done: number, total: number) => void;

export class ConduitClient {
  private readonly base: string;

  constructor(private readonly cfg: Config) {
    if (!cfg.endpoint) {
      throw new ApiError('No endpoint configured. Run `conduit login`.', 0, true);
    }
    this.base = cfg.endpoint.replace(/\/+$/, '') + '/admin/api';
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
      });
    } catch (e) {
      throw new ApiError(`cannot reach ${this.base}${path} — ${(e as Error).message}`, 0);
    }
    // Cloudflare Access rejected the request and redirected to its login page instead
    // of passing through to the Worker. Surface a useful message, not a JSON error.
    if (res.redirected && /cloudflareaccess\.com/i.test(res.url)) {
      throw new ApiError(
        'Cloudflare Access did not accept the service token (it redirected to login). ' +
          'Add a "Service Auth" policy that includes this token to the Access application, ' +
          'and double-check the endpoint.',
        res.status,
        true,
      );
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
    return res;
  }

  async whoami(): Promise<WhoAmI> {
    return (await this.request('/whoami')).json() as Promise<WhoAmI>;
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
    return res.json() as Promise<MintResult>;
  }

  async usage(): Promise<Usage> {
    return (await this.request('/usage')).json() as Promise<Usage>;
  }

  // Routes to a single PUT for small files, or chunked R2 multipart for large ones.
  async upload(path: string, onProgress?: UploadProgress): Promise<FileRow> {
    const { size } = await stat(path);
    const usage = await this.usage();
    if (size > usage.file_limit) {
      throw new ApiError(
        `file is ${formatSize(size)}, over the ${formatSize(usage.file_limit)} per-file limit`,
        0,
      );
    }
    if (usage.used_bytes + size > usage.total_limit) {
      throw new ApiError(
        `not enough storage — ${formatSize(usage.total_limit - usage.used_bytes)} free`,
        0,
      );
    }
    return size <= usage.part_size
      ? this.uploadSingle(path)
      : this.uploadMultipart(path, size, usage.part_size, onProgress);
  }

  private async uploadSingle(path: string): Promise<FileRow> {
    const name = basename(path);
    const data = await readFile(path);
    const res = await this.request('/files', {
      method: 'POST',
      headers: { 'Content-Type': mimeFor(name), 'X-Filename': encodeURIComponent(name) },
      body: new Uint8Array(data),
    });
    return res.json() as Promise<FileRow>;
  }

  private async uploadMultipart(
    path: string,
    size: number,
    fallbackPartSize: number,
    onProgress?: UploadProgress,
  ): Promise<FileRow> {
    const name = basename(path);
    const contentType = mimeFor(name);
    const init = (await (
      await this.request('/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: name, content_type: contentType, size }),
      })
    ).json()) as { file_id: string; key: string; upload_id: string; part_size: number };

    const partSize = init.part_size || fallbackPartSize;
    const fh = await open(path, 'r');
    const parts: Array<{ part_number: number; etag: string }> = [];
    try {
      const buf = Buffer.allocUnsafe(partSize);
      let done = 0;
      let partNumber = 1;
      for (let off = 0; off < size; off += partSize) {
        const len = Math.min(partSize, size - off);
        const { bytesRead } = await fh.read(buf, 0, len, off);
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
      ).json()) as FileRow;
    } catch (e) {
      await this.request('/uploads/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: init.key, upload_id: init.upload_id }),
      }).catch(() => {});
      throw e;
    } finally {
      await fh.close();
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
