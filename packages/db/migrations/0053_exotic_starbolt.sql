CREATE TABLE "job_cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"revoked_epoch" integer DEFAULT 0 NOT NULL,
	"acknowledged_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "job_cancellations_revoked_epoch_check" CHECK ("job_cancellations"."revoked_epoch" >= 0)
);
--> statement-breakpoint
ALTER TABLE "job_cancellations" ADD CONSTRAINT "job_cancellations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cancellations" ADD CONSTRAINT "job_cancellations_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_cancellations_pending_agent_idx" ON "job_cancellations" USING btree ("agent_id","acknowledged_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_cancellations_job_idx" ON "job_cancellations" USING btree ("job_id");