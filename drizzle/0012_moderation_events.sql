-- Moderation events table — immutable audit log of admin actions on resources (#50).
CREATE TABLE IF NOT EXISTS "moderation_events" (
  "id" text PRIMARY KEY NOT NULL,
  "resource_id" text NOT NULL REFERENCES "resources"("id"),
  "action" text NOT NULL,
  "reason" text,
  "actor" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_moderation_events_resource_id" ON "moderation_events" ("resource_id");
