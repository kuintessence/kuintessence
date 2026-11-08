CREATE TABLE "federation_completion_claims" (
	"local_site_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"intent_id" varchar(96) NOT NULL,
	"digest" varchar(71) NOT NULL,
	"allocated_bytes" numeric(30, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_completion_claims_local_site_id_kind_intent_id_pk" PRIMARY KEY("local_site_id","kind","intent_id"),
	CONSTRAINT "federation_completion_claim_kind" CHECK ("federation_completion_claims"."kind" IN ('task', 'market')),
	CONSTRAINT "federation_completion_claim_bytes" CHECK ("federation_completion_claims"."allocated_bytes" > 0 AND "federation_completion_claims"."allocated_bytes" < 1e30)
);
--> statement-breakpoint
CREATE TABLE "federation_completion_pools" (
	"local_site_id" uuid PRIMARY KEY NOT NULL,
	"reserve_id" uuid NOT NULL,
	"capacity_bytes" numeric(30, 0) NOT NULL,
	"task_bytes" numeric(30, 0) NOT NULL,
	"market_bytes" numeric(30, 0) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_completion_pool_bytes" CHECK ("federation_completion_pools"."capacity_bytes" > 0 AND "federation_completion_pools"."capacity_bytes" < 1e30 AND "federation_completion_pools"."task_bytes" > 0 AND "federation_completion_pools"."task_bytes" <= "federation_completion_pools"."capacity_bytes" AND "federation_completion_pools"."market_bytes" > 0 AND "federation_completion_pools"."market_bytes" <= "federation_completion_pools"."capacity_bytes")
);
--> statement-breakpoint
ALTER TABLE "federation_completion_claims" ADD CONSTRAINT "federation_completion_claims_local_site_id_federation_completion_pools_local_site_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_completion_pools"("local_site_id") ON DELETE no action ON UPDATE no action;