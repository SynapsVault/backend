DO $$ BEGIN
  CREATE TYPE "public"."onchain_status_enum" AS ENUM('none', 'pending', 'registered', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "content_hash" text;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "onchain_status" "onchain_status_enum" DEFAULT 'none' NOT NULL;
