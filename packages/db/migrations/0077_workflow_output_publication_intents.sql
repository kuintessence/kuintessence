CREATE TABLE "workflow_output_publication_intents" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"workflow_run_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_output_publication_intents" ADD CONSTRAINT "workflow_output_publication_intents_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_output_publication_intents_pending_idx" ON "workflow_output_publication_intents" USING btree ("next_attempt_at","job_id");