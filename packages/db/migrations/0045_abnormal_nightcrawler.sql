CREATE TABLE "data_delivery_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"reason_code" varchar(128) NOT NULL,
	"destroy_restricted_work_root" boolean DEFAULT false NOT NULL,
	"acknowledged_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_data_bindings" ALTER COLUMN "stage_path" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "job_data_bindings" ALTER COLUMN "stage_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "data_delivery_revocations" ADD CONSTRAINT "data_delivery_revocations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_delivery_revocations" ADD CONSTRAINT "data_delivery_revocations_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_delivery_revocations_pending_agent_idx" ON "data_delivery_revocations" USING btree ("agent_id","acknowledged_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_delivery_revocations_job_reason_idx" ON "data_delivery_revocations" USING btree ("job_id","reason_code");