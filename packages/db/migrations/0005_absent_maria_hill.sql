CREATE TABLE "scheduler_queues" (
	"queue_id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"visible_org_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"scheduler_type" varchar(50) NOT NULL,
	"queue_name" varchar(255) NOT NULL,
	"qos" varchar(255),
	"enabled" boolean DEFAULT true NOT NULL,
	"policy_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "provider_org_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "site_id" varchar(255);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "cluster_id" varchar(255);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "topology" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "queue_id" varchar(255);--> statement-breakpoint
ALTER TABLE "scheduler_queues" ADD CONSTRAINT "scheduler_queues_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler_queues" ADD CONSTRAINT "scheduler_queues_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduler_queues_provider_idx" ON "scheduler_queues" USING btree ("provider_org_id");--> statement-breakpoint
CREATE INDEX "scheduler_queues_agent_idx" ON "scheduler_queues" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "scheduler_queues_enabled_idx" ON "scheduler_queues" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduler_queues_agent_queue_qos_idx" ON "scheduler_queues" USING btree ("agent_id","queue_name","qos");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_queue_id_scheduler_queues_queue_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."scheduler_queues"("queue_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_provider_org_idx" ON "agents" USING btree ("provider_org_id");--> statement-breakpoint
CREATE INDEX "agents_site_cluster_idx" ON "agents" USING btree ("site_id","cluster_id");--> statement-breakpoint
CREATE INDEX "jobs_queue_idx" ON "jobs" USING btree ("queue_id");