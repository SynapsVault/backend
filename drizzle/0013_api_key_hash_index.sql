-- #41 Unique index on publishers.api_key_hash so every authenticated request
-- uses an index scan instead of a sequential scan.
-- Not CONCURRENTLY: drizzle runs migrations inside a transaction, where
-- CREATE INDEX CONCURRENTLY is rejected. For a very large publishers table,
-- pre-create the index CONCURRENTLY by hand; IF NOT EXISTS then makes this a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_publishers_api_key_hash"
  ON "publishers" ("api_key_hash");
