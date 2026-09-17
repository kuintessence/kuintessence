ALTER TABLE "data_replicas" DROP CONSTRAINT "data_replicas_status_check";--> statement-breakpoint
ALTER TABLE "data_replicas" ADD COLUMN "manifest_digest" varchar(128);--> statement-breakpoint
ALTER TABLE "data_replicas" ADD COLUMN "verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "job_data_bindings" ADD COLUMN "stage_path" varchar(2048) DEFAULT 'inputs/data' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_replicas" ADD CONSTRAINT "data_replicas_available_verification_check" CHECK ("data_replicas"."status" <> 'available' OR ("data_replicas"."manifest_digest" IS NOT NULL AND "data_replicas"."verified_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "data_replicas" ADD CONSTRAINT "data_replicas_status_check" CHECK ("data_replicas"."status" IN ('pending', 'syncing', 'available', 'failed', 'stale', 'deleted', 'mismatch', 'expired'));