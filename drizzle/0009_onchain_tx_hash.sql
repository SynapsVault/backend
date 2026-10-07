-- onchain_tx_hash is in the schema but was only ever added by migrations that
-- were missing from the journal; add it here so fresh databases get it.
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "onchain_tx_hash" text;
