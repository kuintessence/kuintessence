ALTER TABLE "agents" ADD COLUMN "compute_health_capable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "compute_health_status" varchar(20) DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "compute_health_observed_at" timestamp;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "compute_health_reason" varchar(64);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "compute_health_node_count" integer;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "compute_health_operational_node_count" integer;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_compute_health_status_check" CHECK ("agents"."compute_health_status" IN ('unknown', 'ready', 'unavailable'));--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_compute_health_node_counts_check" CHECK (
        ("agents"."compute_health_node_count" IS NULL OR "agents"."compute_health_node_count" >= 0)
        AND ("agents"."compute_health_operational_node_count" IS NULL OR "agents"."compute_health_operational_node_count" >= 0)
        AND (
          "agents"."compute_health_node_count" IS NULL
          OR "agents"."compute_health_operational_node_count" IS NULL
          OR "agents"."compute_health_operational_node_count" <= "agents"."compute_health_node_count"
        )
      );