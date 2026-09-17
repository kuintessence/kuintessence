CREATE TABLE "job_work_root_releases" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"acknowledged_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_work_root_releases" ADD CONSTRAINT "job_work_root_releases_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_root_releases" ADD CONSTRAINT "job_work_root_releases_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_work_root_releases_pending_agent_idx" ON "job_work_root_releases" USING btree ("agent_id","acknowledged_at","created_at");