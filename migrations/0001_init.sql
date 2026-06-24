-- CONDUIT data model. System of record for files, capability links, and the
-- append-only download audit trail. PII (recipient IP / geo / device) lives only
-- in `downloads`; it is never exposed on the public /d/<token> path.

PRAGMA foreign_keys = ON;

-- One row per uploaded blob. r2_key points at the object in the R2 bucket.
CREATE TABLE files (
  id            TEXT PRIMARY KEY,                 -- uuid
  r2_key        TEXT NOT NULL UNIQUE,             -- object key in R2
  filename      TEXT NOT NULL,                    -- sanitized original name
  content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT,                             -- optional content hash (reserved)
  created_at    INTEGER NOT NULL,                 -- unix epoch seconds (UTC)
  created_by    TEXT                              -- verified Access email
);

-- One row per capability link. We store ONLY the SHA-256 hash of the raw token;
-- the raw 256-bit secret lives solely in the URL the operator copies. A DB dump
-- cannot reconstruct a working link.
CREATE TABLE links (
  id                 TEXT PRIMARY KEY,            -- uuid
  file_id            TEXT NOT NULL,
  token_hash         TEXT NOT NULL,               -- hex SHA-256(rawToken)
  max_downloads      INTEGER NOT NULL DEFAULT 1,  -- single-use by default
  download_count     INTEGER NOT NULL DEFAULT 0,
  grace_seconds      INTEGER NOT NULL DEFAULT 0,  -- opt-in resume window (0 = strict single download)
  first_download_at  INTEGER,                     -- stamped on first authorize
  expires_at         INTEGER,                     -- NULL = no TTL
  revoked_at         INTEGER,                     -- NULL = live
  created_at         INTEGER NOT NULL,
  created_by         TEXT,
  note               TEXT,
  FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_links_token_hash ON links (token_hash);
CREATE INDEX idx_links_file_id ON links (file_id);
CREATE INDEX idx_links_expires_at ON links (expires_at);

-- Append-only audit of every pull attempt (served and denied). Geo/device come
-- from request.cf; ip from CF-Connecting-IP. link_id/file_id are nullable so a
-- denied pull on an unknown token still logs.
CREATE TABLE downloads (
  id              TEXT PRIMARY KEY,               -- uuid
  link_id         TEXT,
  file_id         TEXT,
  ts              INTEGER NOT NULL,               -- unix epoch seconds (UTC)
  status          TEXT NOT NULL,                  -- 'ok' | 'spent' | 'expired' | 'denied'
  denied_reason   TEXT,                           -- audit-only detail; never surfaced to recipient
  ip              TEXT,
  user_agent      TEXT,
  country         TEXT,
  city            TEXT,
  region          TEXT,
  region_code     TEXT,
  postal_code     TEXT,
  continent       TEXT,
  latitude        TEXT,
  longitude       TEXT,
  timezone        TEXT,
  asn             INTEGER,
  as_organization TEXT,
  colo            TEXT,
  range_header    TEXT,
  range_start     INTEGER,
  range_end       INTEGER,
  bytes_sent      INTEGER,
  FOREIGN KEY (link_id) REFERENCES links (id) ON DELETE SET NULL
);
CREATE INDEX idx_downloads_link_id ON downloads (link_id);
CREATE INDEX idx_downloads_file_id ON downloads (file_id);
CREATE INDEX idx_downloads_ts ON downloads (ts);
CREATE INDEX idx_downloads_status ON downloads (status);
