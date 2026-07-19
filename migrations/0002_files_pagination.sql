-- Stable keyset pagination for the admin file list.
CREATE INDEX idx_files_created_at_id ON files (created_at DESC, id DESC);
