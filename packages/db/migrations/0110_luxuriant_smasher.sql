CREATE TABLE "federation_input_attempts" (
	"generation" uuid PRIMARY KEY NOT NULL,
	"transfer_id" uuid NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"state" varchar(24) DEFAULT 'preparing' NOT NULL,
	"storage_key" varchar(512) NOT NULL,
	"allocation_started_at" timestamp with time zone,
	"cleanup_token" uuid,
	"upload_id" text,
	"lease_until" timestamp with time zone NOT NULL,
	"last_error" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_input_attempt_state" CHECK ("federation_input_attempts"."state" IN ('preparing', 'copying', 'cleanup_pending', 'cleaned')),
	CONSTRAINT "federation_input_attempt_upload" CHECK ("federation_input_attempts"."state" != 'copying' OR ("federation_input_attempts"."upload_id" IS NOT NULL AND "federation_input_attempts"."allocation_started_at" IS NOT NULL)),
	CONSTRAINT "federation_input_attempt_allocated" CHECK ("federation_input_attempts"."upload_id" IS NULL OR "federation_input_attempts"."allocation_started_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "federation_input_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"descriptor" varchar(128) NOT NULL,
	"path" varchar(255) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"part_size" bigint NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_input_transfer_state" CHECK ("federation_input_transfers"."state" IN ('pending', 'copying', 'cleanup_pending', 'cancelled')),
	CONSTRAINT "federation_input_transfer_size" CHECK ("federation_input_transfers"."size_bytes" BETWEEN 0 AND 5497558138880 AND "federation_input_transfers"."part_size" BETWEEN 5242880 AND 5368709120 AND ceil("federation_input_transfers"."size_bytes"::numeric / "federation_input_transfers"."part_size") <= 10000),
	CONSTRAINT "federation_input_transfer_hash" CHECK ("federation_input_transfers"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "federation_input_imports" DROP CONSTRAINT "federation_input_import_state";--> statement-breakpoint
DROP INDEX "federation_input_import_pending";--> statement-breakpoint
ALTER TABLE "federation_input_attempts" ADD CONSTRAINT "federation_input_attempts_transfer_id_federation_input_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."federation_input_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_input_attempts" ADD CONSTRAINT "federation_input_attempts_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_input_transfers" ADD CONSTRAINT "federation_input_transfers_import_id_federation_input_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."federation_input_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_input_attempt_storage" ON "federation_input_attempts" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_input_attempt_active_member" ON "federation_input_attempts" USING btree ("transfer_id") WHERE "federation_input_attempts"."state" != 'cleaned';--> statement-breakpoint
CREATE UNIQUE INDEX "federation_input_attempt_active_agent" ON "federation_input_attempts" USING btree ("agent_id") WHERE "federation_input_attempts"."state" IN ('preparing', 'copying');--> statement-breakpoint
CREATE INDEX "federation_input_attempt_lease" ON "federation_input_attempts" USING btree ("state","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_input_transfer_member" ON "federation_input_transfers" USING btree ("import_id","descriptor","path");--> statement-breakpoint
CREATE INDEX "federation_input_import_pending" ON "federation_input_imports" USING btree ("local_site_id","next_check_at") WHERE "federation_input_imports"."state" IN ('pending', 'transferring');--> statement-breakpoint
ALTER TABLE "federation_input_imports" ADD CONSTRAINT "federation_input_import_state" CHECK ("federation_input_imports"."state" IN ('pending', 'transferring', 'cancelling', 'cancelled'));