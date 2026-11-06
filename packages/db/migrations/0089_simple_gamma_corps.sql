ALTER TABLE "software_operations" ADD COLUMN "replay_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "software_operations" ADD COLUMN "next_dispatch_at" timestamp;--> statement-breakpoint
ALTER TABLE "software_operations" ADD COLUMN "manifest_digest" varchar(71);