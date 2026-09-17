ALTER TABLE "netdrive_transfer_log" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "netdrive_transfer_log" ADD COLUMN "workflow_run_id" uuid;--> statement-breakpoint
ALTER TABLE "netdrive_transfer_log" ADD COLUMN "netdrive_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "netdrive_transfer_log" ADD CONSTRAINT "netdrive_transfer_log_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "netdrive_transfer_log" ADD CONSTRAINT "netdrive_transfer_log_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "netdrive_transfer_log_job_time_idx" ON "netdrive_transfer_log" USING btree ("job_id","occurred_at");--> statement-breakpoint
CREATE INDEX "netdrive_transfer_log_workflow_run_time_idx" ON "netdrive_transfer_log" USING btree ("workflow_run_id","occurred_at");