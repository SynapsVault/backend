-- #41 Unique index on publishers.api_key_hash so every authenticated request
-- uses an index scan instead of a sequential scan.
-- CONCURRENTLY lets the index build without locking the table, so the
-- migration is safe to apply on a live database.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_publishers_api_key_hash"
  ON "publishers" ("api_key_hash");
