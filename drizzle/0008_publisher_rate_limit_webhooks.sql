ALTER TABLE "publishers" ADD COLUMN IF NOT EXISTS "rate_limit_rpm" integer;
--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN IF NOT EXISTS "webhook_url" text;
--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN IF NOT EXISTS "webhook_secret" text;
--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN IF NOT EXISTS "webhook_events" text[];
--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN IF NOT EXISTS "webhook_enabled" boolean DEFAULT false NOT NULL;
