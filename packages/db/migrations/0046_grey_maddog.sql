ALTER TABLE "data_delivery_revocations" ADD COLUMN "revoked_epoch" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "dispatch_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "revoked_epoch" integer DEFAULT 0 NOT NULL;