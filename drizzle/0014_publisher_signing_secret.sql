-- #42 Per-publisher HMAC signing secret stored encrypted (AES-256-GCM via
-- SIGNING_SECRET_KEY). NULL means the publisher pre-dates the feature; they
-- must call POST /publishers/me/signing-secret/rotate to get a secret before
-- signed requests will be accepted.
ALTER TABLE "publishers" ADD COLUMN "signing_secret" text;
