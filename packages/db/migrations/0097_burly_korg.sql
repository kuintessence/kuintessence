CREATE TABLE "federation_result_attempts" (
	"generation" uuid PRIMARY KEY NOT NULL,
	"transfer_id" uuid NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"state" varchar(24) DEFAULT 'preparing' NOT NULL,
	"storage_key" varchar(512) NOT NULL,
	"upload_id" text,
	"parts" jsonb,
	"lease_until" timestamp with time zone NOT NULL,
	"last_error" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_result_attempt_state" CHECK ("federation_result_attempts"."state" IN ('preparing','copying','assembling','verifying','verified','available','cleanup_pending','cleaned')),
	CONSTRAINT "federation_result_attempt_upload" CHECK ("federation_result_attempts"."state" NOT IN ('copying','assembling','verifying','verified','available') OR "federation_result_attempts"."upload_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "federation_result_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"report" jsonb NOT NULL,
	"report_jws" text NOT NULL,
	"manifest_digest" varchar(71) NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_result_import_state" CHECK ("federation_result_imports"."state" IN ('pending','transferring','verifying','available','cancelled','needs_review'))
);
--> statement-breakpoint
CREATE TABLE "federation_result_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"import_id" uuid NOT NULL,
	"output_id" varchar(71) NOT NULL,
	"path" varchar(255) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"part_size" bigint NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_result_transfer_state" CHECK ("federation_result_transfers"."state" IN ('pending','copying','assembling','verifying','verified','available','cleanup_pending','cancelled')),
	CONSTRAINT "federation_result_transfer_size" CHECK ("federation_result_transfers"."size_bytes" >= 0 AND "federation_result_transfers"."size_bytes" <= 5497558138880 AND "federation_result_transfers"."part_size" >= 5242880 AND "federation_result_transfers"."part_size" <= 5368709120),
	CONSTRAINT "federation_result_transfer_hash" CHECK ("federation_result_transfers"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "federation_result_attempts" ADD CONSTRAINT "federation_result_attempts_transfer_id_federation_result_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."federation_result_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_result_attempts" ADD CONSTRAINT "federation_result_attempts_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_result_imports" ADD CONSTRAINT "federation_result_imports_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_result_imports" ADD CONSTRAINT "federation_result_imports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_result_imports" ADD CONSTRAINT "federation_result_imports_local_site_id_operation_id_federation_outbound_local_site_id_operation_id_fk" FOREIGN KEY ("local_site_id","operation_id") REFERENCES "public"."federation_outbound"("local_site_id","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_result_transfers" ADD CONSTRAINT "federation_result_transfers_import_id_federation_result_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."federation_result_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_result_attempt_storage" ON "federation_result_attempts" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_result_attempt_active_member" ON "federation_result_attempts" USING btree ("transfer_id") WHERE "federation_result_attempts"."state" <> 'cleaned';--> statement-breakpoint
CREATE UNIQUE INDEX "federation_result_attempt_active_agent" ON "federation_result_attempts" USING btree ("agent_id") WHERE "federation_result_attempts"."state" IN ('preparing','copying','assembling','verifying');--> statement-breakpoint
CREATE INDEX "federation_result_attempt_lease" ON "federation_result_attempts" USING btree ("state","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_result_import_manifest" ON "federation_result_imports" USING btree ("local_site_id","operation_id","requested_by","manifest_digest");--> statement-breakpoint
CREATE INDEX "federation_result_import_owner" ON "federation_result_imports" USING btree ("local_site_id","local_org_id","requested_by","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_result_transfer_member" ON "federation_result_transfers" USING btree ("import_id","output_id","path");