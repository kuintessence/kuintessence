CREATE TABLE "agent_job_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"job_id" uuid NOT NULL,
	"status" varchar(20) NOT NULL,
	"processed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_job_status_events" ADD CONSTRAINT "agent_job_status_events_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_job_status_events" ADD CONSTRAINT "agent_job_status_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_job_status_events_agent_event_idx" ON "agent_job_status_events" USING btree ("agent_id","event_id");--> statement-breakpoint
CREATE INDEX "agent_job_status_events_job_idx" ON "agent_job_status_events" USING btree ("job_id");