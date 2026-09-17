CREATE TABLE "file_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"direction" varchar(32) NOT NULL,
	"source" text NOT NULL,
	"target" text NOT NULL,
	"source_file_id" uuid,
	"agent_id" varchar(255),
	"site_id" varchar(255),
	"total_bytes" bigint,
	"copied_bytes" bigint DEFAULT 0 NOT NULL,
	"state" varchar(32) NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"error" text,
	"job_id" uuid,
	"workflow_run_id" uuid,
	"netdrive_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "file_transfers_direction_check" CHECK ("file_transfers"."direction" IN ('cloud_to_cluster', 'cluster_to_cloud')),
	CONSTRAINT "file_transfers_state_check" CHECK ("file_transfers"."state" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_source_file_id_netdrive_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."netdrive_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_transfers_user_created_idx" ON "file_transfers" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "file_transfers_state_idx" ON "file_transfers" USING btree ("state");--> statement-breakpoint
CREATE INDEX "file_transfers_job_idx" ON "file_transfers" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "file_transfers_workflow_run_idx" ON "file_transfers" USING btree ("workflow_run_id");