-- Idempotent marker: existing rows with plaintext webhook secrets cannot be
-- automatically re-encrypted here because the encryption key is not available
-- in SQL migrations. The application layer handles encryption on write and
-- decryption on read. Rows already encrypted (base64 AES-GCM blobs) are
-- detected by the application; rows still in plain text continue to work
-- until the publisher updates their secret.
-- This migration is intentionally a no-op so it can be run multiple times
-- safely — the real change is in the application code (#47).
SELECT 1;
