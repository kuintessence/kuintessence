CREATE TABLE "job_dispatch_outbox" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"dispatch_epoch" integer NOT NULL,
	"payload_base64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "job_dispatch_outbox_epoch" CHECK ("job_dispatch_outbox"."dispatch_epoch" > 0)
);
--> statement-breakpoint
ALTER TABLE "job_dispatch_outbox" ADD CONSTRAINT "job_dispatch_outbox_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_dispatch_outbox" ADD CONSTRAINT "job_dispatch_outbox_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_dispatch_outbox_pending" ON "job_dispatch_outbox" USING btree ("next_attempt_at") WHERE "job_dispatch_outbox"."acknowledged_at" IS NULL;