-- Brings the database in line with src/db/schema.ts. These objects were added
-- to the schema without a migration (#87, #89, #98, #99, #101, #103, #105).
-- Every statement is idempotent so databases patched by hand are safe.
DO $$ BEGIN
  CREATE TYPE "public"."payment_status" AS ENUM('pending', 'settled', 'failed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."thumbnail_status_enum" AS ENUM('none', 'pending', 'ready', 'failed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Payments recorded before settlement tracking were only written after a
-- verified x402 payment, so backfill them as settled; new rows start pending.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'status'
  ) THEN
    ALTER TABLE "payments" ADD COLUMN "status" "payment_status" NOT NULL DEFAULT 'settled';
    ALTER TABLE "payments" ALTER COLUMN "status" SET DEFAULT 'pending';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "verification_id" text REFERENCES "verifications"("id");
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "thumbnail_status" "thumbnail_status_enum" NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "tags" text[];
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_cleanup" (
  "id" text PRIMARY KEY NOT NULL,
  "storage_path" text NOT NULL,
  "resource_id" text REFERENCES "resources"("id"),
  "attempts" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "failed_events" (
  "id" text PRIMARY KEY NOT NULL,
  "event_id" text NOT NULL,
  "ledger" integer NOT NULL,
  "topic" text NOT NULL,
  "payload" text NOT NULL,
  "error" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 1,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ledger_checkpoints" (
  "contract_id" text PRIMARY KEY NOT NULL,
  "last_ledger" integer NOT NULL,
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_resources_thumbnail_status" ON "resources" ("thumbnail_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pending_cleanup_created_at" ON "pending_cleanup" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_verifications_checked_at" ON "verifications" ("checked_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payments_recipient_address" ON "payments" ("recipient_address");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_failed_events_event_id" ON "failed_events" ("event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_failed_events_ledger" ON "failed_events" ("ledger");
