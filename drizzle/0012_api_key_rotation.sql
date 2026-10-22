-- #40 API key rotation: store revocation timestamp so old keys can be
-- invalidated without deleting the row. NULL means the key is still active.
ALTER TABLE "publishers" ADD COLUMN IF NOT EXISTS "api_key_revoked_at" timestamp;
