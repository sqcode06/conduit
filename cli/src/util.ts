// Pure helpers: exit codes, duration parsing, formatting.

export const EXIT = {
  OK: 0,
  USAGE: 1, // bad arguments / user error
  RUNTIME: 2, // unexpected runtime / network error
  AUTH: 3, // missing or invalid config / auth
} as const;

export const MAX_TTL_SECONDS = 365 * 24 * 60 * 60;

// Parse a human duration into seconds. Accepts "30s", "15m", "24h", "7d", or
// "none" / "never" / "0" -> null (no expiry). Throws on anything else.
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (s === 'none' || s === 'never' || s === '0') return null;
  const m = /^(\d+)\s*(s|m|h|d)?$/.exec(s);
  if (!m) throw new Error(`invalid duration "${input}" (use e.g. 30m, 24h, 7d, or none)`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const mult = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  const seconds = n * mult;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_TTL_SECONDS) {
    throw new Error(`duration must be between 1s and 365d, or none`);
  }
  return seconds;
}

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const val = i === 0 ? n : n < 10 ? Number(n.toFixed(1)) : Math.round(n);
  return `${val} ${units[i]}`;
}

// Relative time for a FUTURE instant (e.g. link expiry): "in 24h", "in 7d".
export function formatUntil(iso: string | null | undefined): string {
  if (!iso) return 'no expiry';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = (t - Date.now()) / 1000;
  if (diff <= 0) return 'expired';
  if (diff < 3600) return `in ${Math.ceil(diff / 60)}m`;
  if (diff < 86400) return `in ${Math.round(diff / 3600)}h`;
  return `in ${Math.round(diff / 86400)}d`;
}

export function formatRelTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
