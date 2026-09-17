ALTER TABLE "workflow_runs" ADD COLUMN "input" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "error_code" varchar(80);--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "submitted_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "queued_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "started_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "completed_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "cancel_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "executor_id" varchar(120);--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "lease_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;