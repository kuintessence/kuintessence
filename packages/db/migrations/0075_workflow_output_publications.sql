CREATE TABLE "workflow_output_publications" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"input" jsonb NOT NULL,
	"files" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"token" uuid,
	"lease_until" timestamp,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"error" text,
	"released_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_output_publications" ADD CONSTRAINT "workflow_output_publications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;