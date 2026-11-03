ALTER TABLE "orgs" ADD COLUMN "profile" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;