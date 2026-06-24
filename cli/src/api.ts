import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Config } from './config';

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

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

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

  async upload(path: string): Promise<FileRow> {
    const data = await readFile(path);
    if (data.byteLength > MAX_UPLOAD_BYTES) {
      throw new ApiError(`file is larger than the 100 MB limit (${data.byteLength} bytes)`, 0);
    }
    const name = basename(path);
    const res = await this.request('/files', {
      method: 'POST',
      headers: { 'Content-Type': mimeFor(name), 'X-Filename': encodeURIComponent(name) },
      body: new Uint8Array(data),
    });
    return res.json() as Promise<FileRow>;
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
