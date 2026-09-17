ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_status_check";--> statement-breakpoint
ALTER TABLE "workflow_runs" ALTER COLUMN "status" SET DEFAULT 'submitted';--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_status_check" CHECK ("workflow_runs"."status" IN ('submitted', 'queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled'));