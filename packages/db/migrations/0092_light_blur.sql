DROP INDEX "job_cancellations_job_idx";--> statement-breakpoint
ALTER TABLE "job_cancellations" ADD COLUMN "requires_installation_stop" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "job_cancellations_job_agent_idx" ON "job_cancellations" USING btree ("job_id","agent_id");