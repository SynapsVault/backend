-- Webhook outbox: persists pending/in-flight deliveries so they survive crashes
-- and restarts (#48). A background worker picks them up and retries with
-- exponential backoff.
CREATE TABLE IF NOT EXISTS "webhook_outbox" (
  "id" text PRIMARY KEY NOT NULL,
  "publisher_id" text NOT NULL REFERENCES "publishers"("id"),
  "event" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',  -- pending | delivered | failed
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 3,
  "last_error" text,
  "delivery_id" text,
  "next_attempt_at" timestamp NOT NULL DEFAULT now(),
  "delivered_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Worker polls for pending rows ordered by next_attempt_at.
CREATE INDEX IF NOT EXISTS "idx_webhook_outbox_status_next" ON "webhook_outbox" ("status", "next_attempt_at");
--> statement-breakpoint
-- Publisher delivery-history endpoint queries by publisher_id.
CREATE INDEX IF NOT EXISTS "idx_webhook_outbox_publisher_id" ON "webhook_outbox" ("publisher_id", "created_at");
