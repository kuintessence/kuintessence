CREATE TABLE "workflow_execution_jobs" (
	"run_id" uuid NOT NULL,
	"path_hash" varchar(64) NOT NULL,
	"path" text NOT NULL,
	"node_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"intent" jsonb NOT NULL,
	"dispatch_state" varchar(16) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_execution_jobs_run_id_path_hash_pk" PRIMARY KEY("run_id","path_hash"),
	CONSTRAINT "workflow_execution_job_hash" CHECK ("workflow_execution_jobs"."path_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workflow_execution_job_dispatch_state" CHECK ("workflow_execution_jobs"."dispatch_state" IN ('pending', 'acknowledged'))
);
--> statement-breakpoint
ALTER TABLE "workflow_execution_jobs" ADD CONSTRAINT "workflow_execution_jobs_run_id_workflow_execution_leases_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_execution_leases"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_jobs" ADD CONSTRAINT "workflow_execution_jobs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_execution_job_unique" ON "workflow_execution_jobs" USING btree ("job_id");