CREATE TABLE "queue_observability_counters" (
	"metric" varchar(64) NOT NULL,
	"failure_code" varchar(64) NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "queue_observability_counters_pkey" PRIMARY KEY("metric","failure_code")
);
--> statement-breakpoint
CREATE TABLE "queue_observability_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"metric" varchar(64) NOT NULL,
	"failure_code" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "queue_observability_events" ADD CONSTRAINT "queue_observability_events_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "queue_observability_events_agent_event_metric_idx" ON "queue_observability_events" USING btree ("agent_id","event_id","metric");