ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "onchain_attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "delivery_status" text NOT NULL DEFAULT 'delivered';
