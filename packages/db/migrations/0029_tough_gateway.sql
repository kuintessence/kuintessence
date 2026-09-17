CREATE TABLE "storage_quota_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" varchar(32) NOT NULL,
	"scope_id" varchar(255) NOT NULL,
	"quota_bytes" bigint NOT NULL,
	"source" varchar(16) NOT NULL,
	"request_id" uuid,
	"note" text,
	"starts_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"granted_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "storage_quota_grants_scope_check" CHECK ("storage_quota_grants"."scope" IN ('cloud', 'cluster_root')),
	CONSTRAINT "storage_quota_grants_source_check" CHECK ("storage_quota_grants"."source" IN ('manual', 'temporary', 'auto', 'request'))
);
--> statement-breakpoint
CREATE TABLE "storage_quota_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" varchar(32) NOT NULL,
	"scope_id" varchar(255) NOT NULL,
	"provider_org_id" uuid,
	"default_quota_bytes" bigint NOT NULL,
	"max_quota_bytes" bigint,
	"request_mode" varchar(16) DEFAULT 'manual' NOT NULL,
	"auto_approve_limit_bytes" bigint,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "storage_quota_policies_scope_check" CHECK ("storage_quota_policies"."scope" IN ('cloud', 'cluster_root')),
	CONSTRAINT "storage_quota_policies_request_mode_check" CHECK ("storage_quota_policies"."request_mode" IN ('auto', 'manual', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "storage_quota_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" varchar(32) NOT NULL,
	"scope_id" varchar(255) NOT NULL,
	"requested_quota_bytes" bigint NOT NULL,
	"requested_expires_at" timestamp,
	"reason" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decision_note" text,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "storage_quota_requests_scope_check" CHECK ("storage_quota_requests"."scope" IN ('cloud', 'cluster_root')),
	CONSTRAINT "storage_quota_requests_status_check" CHECK ("storage_quota_requests"."status" IN ('pending', 'approved', 'rejected', 'cancelled', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "cluster_file_roots" ADD COLUMN "capacity_bytes" bigint;--> statement-breakpoint
ALTER TABLE "storage_quota_grants" ADD CONSTRAINT "storage_quota_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_quota_grants" ADD CONSTRAINT "storage_quota_grants_request_id_storage_quota_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."storage_quota_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_quota_grants" ADD CONSTRAINT "storage_quota_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_quota_policies" ADD CONSTRAINT "storage_quota_policies_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_quota_policies" ADD CONSTRAINT "storage_quota_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_quota_requests" ADD CONSTRAINT "storage_quota_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_quota_requests" ADD CONSTRAINT "storage_quota_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_quota_grants_user_scope_idx" ON "storage_quota_grants" USING btree ("user_id","scope","scope_id");--> statement-breakpoint
CREATE INDEX "storage_quota_grants_expiry_idx" ON "storage_quota_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_quota_policies_scope_unique" ON "storage_quota_policies" USING btree ("scope","scope_id");--> statement-breakpoint
CREATE INDEX "storage_quota_policies_provider_idx" ON "storage_quota_policies" USING btree ("provider_org_id");--> statement-breakpoint
CREATE INDEX "storage_quota_requests_user_time_idx" ON "storage_quota_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "storage_quota_requests_scope_status_idx" ON "storage_quota_requests" USING btree ("scope","scope_id","status");