import { hashToken, nowSeconds } from './tokens';

// Single, atomic authorize-and-consume. D1 runs each statement as its own
// auto-commit transaction with no concurrent execution inside the database, so
// this conditional UPDATE ... RETURNING cannot double-spend a single-use link:
// the `download_count < max_downloads` guard is evaluated and the increment
// applied in one indivisible step. Two simultaneous hits on a 1-use link cannot
// both pass. Within the grace window, re-requests are authorized WITHOUT a
// further increment, so a dropped/resumed download finishes without burning a use.
export const CONSUME_SQL = `
UPDATE links
SET download_count = download_count + CASE WHEN download_count < max_downloads THEN 1 ELSE 0 END,
    first_download_at = COALESCE(first_download_at, ?2)
WHERE token_hash = ?1
  AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > ?2)
  AND (download_count < max_downloads
       OR (first_download_at IS NOT NULL AND ?2 < first_download_at + grace_seconds))
RETURNING id AS link_id, file_id, download_count, max_downloads, first_download_at, grace_seconds;
`;

export interface ConsumeRow {
  link_id: string;
  file_id: string;
  download_count: number;
  max_downloads: number;
  first_download_at: number;
  grace_seconds: number;
}

export interface ConsumeResult {
  ok: boolean;
  row?: ConsumeRow;
  kind?: 'consumed' | 'grace_resume';
}

export async function consumeLink(db: D1Database, rawToken: string): Promise<ConsumeResult> {
  const now = nowSeconds();
  const tokenHash = await hashToken(rawToken);
  const row = await db.prepare(CONSUME_SQL).bind(tokenHash, now).first<ConsumeRow>();
  if (!row) return { ok: false };
  // first_download_at === now means we just stamped it (fresh consume); otherwise
  // it was already set and this hit rode the grace window.
  const kind = row.first_download_at === now ? 'consumed' : 'grace_resume';
  return { ok: true, row, kind };
}

// Non-mutating classification: used for HEAD (must never consume) and to label a
// denied audit row. NEVER changes the response shown to the recipient.
export type DenyReason = 'not_found' | 'revoked' | 'expired' | 'spent' | 'usable';

export interface PeekRow {
  id: string;
  file_id: string;
  max_downloads: number;
  download_count: number;
  grace_seconds: number;
  first_download_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

export async function peekLink(
  db: D1Database,
  rawToken: string,
): Promise<{ link: PeekRow | null; reason: DenyReason }> {
  const now = nowSeconds();
  const tokenHash = await hashToken(rawToken);
  const link = await db
    .prepare(
      `SELECT id, file_id, max_downloads, download_count, grace_seconds,
              first_download_at, expires_at, revoked_at
       FROM links WHERE token_hash = ?1`,
    )
    .bind(tokenHash)
    .first<PeekRow>();
  if (!link) return { link: null, reason: 'not_found' };
  if (link.revoked_at !== null) return { link, reason: 'revoked' };
  if (link.expires_at !== null && link.expires_at <= now) return { link, reason: 'expired' };
  const budgetLeft = link.download_count < link.max_downloads;
  const withinGrace =
    link.first_download_at !== null && now < link.first_download_at + link.grace_seconds;
  if (!budgetLeft && !withinGrace) return { link, reason: 'spent' };
  return { link, reason: 'usable' };
}
