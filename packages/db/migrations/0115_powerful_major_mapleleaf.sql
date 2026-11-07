CREATE TABLE "federation_terminal_evidence" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"reservation_id" uuid NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"evidence" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_terminal_digest" CHECK ("federation_terminal_evidence"."digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "federation_terminal_identity" CHECK (coalesce(
      "federation_terminal_evidence"."evidence"->>'version' = '1'
      AND "federation_terminal_evidence"."evidence"->>'jobId' = "federation_terminal_evidence"."job_id"::text
      AND "federation_terminal_evidence"."evidence"->>'reservationId' = "federation_terminal_evidence"."reservation_id"::text
      AND "federation_terminal_evidence"."evidence"->>'runId' = "federation_terminal_evidence"."workflow_run_id"::text
      AND "federation_terminal_evidence"."evidence"->>'status' IN ('completed','failed','cancelled'), false))
);
--> statement-breakpoint
ALTER TABLE "federation_terminal_evidence" ADD CONSTRAINT "federation_terminal_evidence_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_terminal_evidence" ADD CONSTRAINT "federation_terminal_evidence_reservation_id_federation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."federation_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_terminal_evidence" ADD CONSTRAINT "federation_terminal_evidence_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_terminal_reservation" ON "federation_terminal_evidence" USING btree ("reservation_id","job_id");