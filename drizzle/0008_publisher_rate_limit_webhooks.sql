ALTER TABLE "publishers" ADD COLUMN "rate_limit_rpm" integer;
--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "webhook_url" text;
--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "webhook_secret" text;
--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "webhook_events" text[];
--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "webhook_enabled" boolean DEFAULT false NOT NULL;