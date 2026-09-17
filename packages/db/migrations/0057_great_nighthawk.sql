CREATE TABLE "agent_scheduler_queue_snapshots" (
	"agent_id" varchar(255) PRIMARY KEY NOT NULL,
	"queue_inventory_v1" boolean DEFAULT false NOT NULL,
	"status" varchar(32) DEFAULT 'unknown' NOT NULL,
	"default_queue_name" varchar(255),
	"reason" varchar(64),
	"observed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_scheduler_queue_snapshots_status_check" CHECK ("agent_scheduler_queue_snapshots"."status" IN ('unknown', 'available', 'unavailable', 'stale', 'unsupported')),
	CONSTRAINT "agent_scheduler_queue_snapshots_reason_check" CHECK ("agent_scheduler_queue_snapshots"."reason" IS NULL OR "agent_scheduler_queue_snapshots"."reason" IN ('command_failed', 'invalid_output', 'multiple_default_queues', 'default_queue_missing', 'unsupported_scheduler', 'stale', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "agent_scheduler_queues" (
	"agent_id" varchar(255) NOT NULL,
	"queue_name" varchar(255) NOT NULL,
	"queue_type" varchar(32) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"state" varchar(32) NOT NULL,
	"accepts_submissions" boolean NOT NULL,
	"has_compute_targets" boolean,
	"observed_at" timestamp NOT NULL,
	CONSTRAINT "agent_scheduler_queues_pkey" PRIMARY KEY("agent_id","queue_name"),
	CONSTRAINT "agent_scheduler_queues_state_check" CHECK ("agent_scheduler_queues"."state" IN ('up', 'down', 'unknown')),
	CONSTRAINT "agent_scheduler_queues_type_check" CHECK ("agent_scheduler_queues"."queue_type" IN ('partition', 'execution', 'route', 'namespace', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "scheduler_queues" ALTER COLUMN "queue_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "queue_target_mode" varchar(16);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "scheduler_queue_name" varchar(255);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "queue_observed_at" timestamp;--> statement-breakpoint
ALTER TABLE "scheduler_queues" ADD COLUMN "target_mode" varchar(16) DEFAULT 'named' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_scheduler_queue_snapshots" ADD CONSTRAINT "agent_scheduler_queue_snapshots_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_scheduler_queues" ADD CONSTRAINT "agent_scheduler_queues_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_scheduler_queues_one_default_idx" ON "agent_scheduler_queues" USING btree ("agent_id") WHERE "agent_scheduler_queues"."is_default";--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_queue_target_mode_check" CHECK ("jobs"."queue_target_mode" IS NULL OR "jobs"."queue_target_mode" IN ('default', 'named'));--> statement-breakpoint
ALTER TABLE "scheduler_queues" ADD CONSTRAINT "scheduler_queues_target_mode_check" CHECK ("scheduler_queues"."target_mode" IN ('default', 'named'));--> statement-breakpoint
ALTER TABLE "scheduler_queues" ADD CONSTRAINT "scheduler_queues_target_queue_name_check" CHECK (("scheduler_queues"."target_mode" = 'default' AND "scheduler_queues"."queue_name" IS NULL) OR ("scheduler_queues"."target_mode" = 'named' AND "scheduler_queues"."queue_name" IS NOT NULL));