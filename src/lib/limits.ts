// Upload limits — the single source of truth. Clients (browser + CLI) learn the
// part size from the multipart-init response and the caps from /usage, so they
// never hardcode these.

export const MAX_FILE_BYTES = 1024 ** 3; // 1 GiB per file
export const MAX_TOTAL_BYTES = 10 * 1024 ** 3; // 10 GiB total across all files

// 50 MiB: safely under the 100 MB Worker request-body limit and >= R2's 5 MiB
// minimum part size. Configurable via env so tests can use tiny parts.
const DEFAULT_PART_SIZE = 50 * 1024 * 1024;

export function getPartSize(env: { UPLOAD_PART_SIZE?: string }): number {
  const v = Number(env?.UPLOAD_PART_SIZE);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_PART_SIZE;
}

// Human-readable size for messages: "1 GB", "10 GB", "3.2 GB".
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Math.max(0, n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const val = i === 0 ? v : v < 10 ? Number(v.toFixed(1)) : Math.round(v);
  return `${val} ${units[i]}`;
}
