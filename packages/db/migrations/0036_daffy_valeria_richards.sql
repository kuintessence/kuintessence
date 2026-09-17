CREATE TABLE "data_access_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_asset_id" uuid NOT NULL,
	"data_asset_version_id" uuid,
	"subject_kind" varchar(32) NOT NULL,
	"subject_id" varchar(255) NOT NULL,
	"effect" varchar(16) DEFAULT 'allow' NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "data_access_policies_subject_check" CHECK ("data_access_policies"."subject_kind" IN ('user', 'org', 'provider-org', 'platform')),
	CONSTRAINT "data_access_policies_effect_check" CHECK ("data_access_policies"."effect" IN ('allow', 'deny')),
	CONSTRAINT "data_access_policies_status_check" CHECK ("data_access_policies"."status" IN ('active', 'disabled', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "data_access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_asset_id" uuid NOT NULL,
	"data_asset_version_id" uuid,
	"capability" varchar(32) NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"requester_org_id" uuid,
	"subject_kind" varchar(32) NOT NULL,
	"subject_id" varchar(255) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"reason" text,
	"decision_reason" text,
	"decided_by" uuid,
	"decided_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "data_access_requests_capability_check" CHECK ("data_access_requests"."capability" IN ('view', 'use', 'download', 'derive', 'manage')),
	CONSTRAINT "data_access_requests_subject_check" CHECK ("data_access_requests"."subject_kind" IN ('user', 'org')),
	CONSTRAINT "data_access_requests_status_check" CHECK ("data_access_requests"."status" IN ('pending', 'approved', 'rejected', 'canceled', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "data_asset_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_asset_id" uuid NOT NULL,
	"version" varchar(128) NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"content_hash" varchar(128),
	"size_bytes" bigint,
	"format" varchar(128),
	"schema_uri" text,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"immutable_at" timestamp,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "data_asset_versions_status_check" CHECK ("data_asset_versions"."status" IN ('draft', 'available', 'deprecated', 'revoked', 'archived')),
	CONSTRAINT "data_asset_versions_immutable_status_check" CHECK ("data_asset_versions"."status" = 'draft' OR "data_asset_versions"."immutable_at" IS NOT NULL),
	CONSTRAINT "data_asset_versions_size_bytes_check" CHECK ("data_asset_versions"."size_bytes" IS NULL OR "data_asset_versions"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "data_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"owner_org_id" uuid,
	"provider_org_id" uuid,
	"kind" varchar(32) DEFAULT 'dataset' NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"lifecycle" varchar(32) DEFAULT 'draft' NOT NULL,
	"visibility" varchar(32) DEFAULT 'private' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "data_assets_kind_check" CHECK ("data_assets"."kind" IN ('dataset', 'reference', 'artifact')),
	CONSTRAINT "data_assets_lifecycle_check" CHECK ("data_assets"."lifecycle" IN ('draft', 'published', 'deprecated', 'revoked', 'archived')),
	CONSTRAINT "data_assets_visibility_check" CHECK ("data_assets"."visibility" IN ('private', 'shared-to-orgs', 'platform-public', 'hidden'))
);
--> statement-breakpoint
CREATE TABLE "data_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_asset_id" uuid NOT NULL,
	"data_asset_version_id" uuid,
	"subject_kind" varchar(32) NOT NULL,
	"subject_id" varchar(255) NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"reason" text,
	"granted_by" uuid,
	"starts_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "data_grants_subject_check" CHECK ("data_grants"."subject_kind" IN ('user', 'org', 'provider-org', 'platform')),
	CONSTRAINT "data_grants_status_check" CHECK ("data_grants"."status" IN ('active', 'revoked', 'expired')),
	CONSTRAINT "data_grants_lifetime_check" CHECK ("data_grants"."expires_at" IS NULL OR "data_grants"."expires_at" > "data_grants"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "data_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_asset_version_id" uuid NOT NULL,
	"provider_org_id" uuid,
	"site_id" varchar(255),
	"agent_id" varchar(255),
	"kind" varchar(32) NOT NULL,
	"uri" text NOT NULL,
	"status" varchar(32) DEFAULT 'available' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "data_locations_kind_check" CHECK ("data_locations"."kind" IN ('object-store', 'netdrive', 'cluster-filesystem', 'external')),
	CONSTRAINT "data_locations_status_check" CHECK ("data_locations"."status" IN ('available', 'unavailable', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "data_replicas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_asset_version_id" uuid NOT NULL,
	"source_location_id" uuid,
	"target_location_id" uuid,
	"target_site_id" varchar(255) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"bytes_copied" bigint DEFAULT 0 NOT NULL,
	"error_message" text,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "data_replicas_status_check" CHECK ("data_replicas"."status" IN ('pending', 'syncing', 'available', 'failed', 'stale', 'deleted')),
	CONSTRAINT "data_replicas_bytes_copied_check" CHECK ("data_replicas"."bytes_copied" >= 0)
);
--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD CONSTRAINT "data_access_policies_data_asset_id_data_assets_id_fk" FOREIGN KEY ("data_asset_id") REFERENCES "public"."data_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD CONSTRAINT "data_access_policies_data_asset_version_id_data_asset_versions_id_fk" FOREIGN KEY ("data_asset_version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD CONSTRAINT "data_access_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_access_requests" ADD CONSTRAINT "data_access_requests_data_asset_id_data_assets_id_fk" FOREIGN KEY ("data_asset_id") REFERENCES "public"."data_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_access_requests" ADD CONSTRAINT "data_access_requests_data_asset_version_id_data_asset_versions_id_fk" FOREIGN KEY ("data_asset_version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_access_requests" ADD CONSTRAINT "data_access_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_access_requests" ADD CONSTRAINT "data_access_requests_requester_org_id_orgs_id_fk" FOREIGN KEY ("requester_org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_access_requests" ADD CONSTRAINT "data_access_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_asset_versions" ADD CONSTRAINT "data_asset_versions_data_asset_id_data_assets_id_fk" FOREIGN KEY ("data_asset_id") REFERENCES "public"."data_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_asset_versions" ADD CONSTRAINT "data_asset_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_assets" ADD CONSTRAINT "data_assets_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_assets" ADD CONSTRAINT "data_assets_owner_org_id_orgs_id_fk" FOREIGN KEY ("owner_org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_assets" ADD CONSTRAINT "data_assets_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_assets" ADD CONSTRAINT "data_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_grants" ADD CONSTRAINT "data_grants_data_asset_id_data_assets_id_fk" FOREIGN KEY ("data_asset_id") REFERENCES "public"."data_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_grants" ADD CONSTRAINT "data_grants_data_asset_version_id_data_asset_versions_id_fk" FOREIGN KEY ("data_asset_version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_grants" ADD CONSTRAINT "data_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_locations" ADD CONSTRAINT "data_locations_data_asset_version_id_data_asset_versions_id_fk" FOREIGN KEY ("data_asset_version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_locations" ADD CONSTRAINT "data_locations_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_locations" ADD CONSTRAINT "data_locations_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_replicas" ADD CONSTRAINT "data_replicas_data_asset_version_id_data_asset_versions_id_fk" FOREIGN KEY ("data_asset_version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_replicas" ADD CONSTRAINT "data_replicas_source_location_id_data_locations_id_fk" FOREIGN KEY ("source_location_id") REFERENCES "public"."data_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_replicas" ADD CONSTRAINT "data_replicas_target_location_id_data_locations_id_fk" FOREIGN KEY ("target_location_id") REFERENCES "public"."data_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_access_policies_asset_subject_idx" ON "data_access_policies" USING btree ("data_asset_id","data_asset_version_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "data_access_policies_subject_idx" ON "data_access_policies" USING btree ("subject_kind","subject_id","status");--> statement-breakpoint
CREATE INDEX "data_access_requests_asset_status_idx" ON "data_access_requests" USING btree ("data_asset_id","status");--> statement-breakpoint
CREATE INDEX "data_access_requests_requester_idx" ON "data_access_requests" USING btree ("requester_user_id","status");--> statement-breakpoint
CREATE INDEX "data_access_requests_subject_idx" ON "data_access_requests" USING btree ("subject_kind","subject_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "data_asset_versions_asset_version_idx" ON "data_asset_versions" USING btree ("data_asset_id","version");--> statement-breakpoint
CREATE INDEX "data_asset_versions_status_idx" ON "data_asset_versions" USING btree ("data_asset_id","status");--> statement-breakpoint
CREATE INDEX "data_assets_owner_idx" ON "data_assets" USING btree ("owner_user_id","owner_org_id");--> statement-breakpoint
CREATE INDEX "data_assets_provider_idx" ON "data_assets" USING btree ("provider_org_id");--> statement-breakpoint
CREATE INDEX "data_assets_lifecycle_idx" ON "data_assets" USING btree ("lifecycle");--> statement-breakpoint
CREATE UNIQUE INDEX "data_grants_asset_subject_idx" ON "data_grants" USING btree ("data_asset_id","data_asset_version_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "data_grants_subject_idx" ON "data_grants" USING btree ("subject_kind","subject_id","status");--> statement-breakpoint
CREATE INDEX "data_grants_status_expiry_idx" ON "data_grants" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_locations_version_uri_idx" ON "data_locations" USING btree ("data_asset_version_id","uri");--> statement-breakpoint
CREATE INDEX "data_locations_site_status_idx" ON "data_locations" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "data_locations_agent_idx" ON "data_locations" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_replicas_version_target_site_idx" ON "data_replicas" USING btree ("data_asset_version_id","target_site_id");--> statement-breakpoint
CREATE INDEX "data_replicas_status_idx" ON "data_replicas" USING btree ("status","target_site_id");