CREATE TABLE IF NOT EXISTS "idempotency_records" (
	"key" text PRIMARY KEY NOT NULL,
	"record" jsonb NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_idempotency_records_expires_at" ON "idempotency_records" ("expires_at");
