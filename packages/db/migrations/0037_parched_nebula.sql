CREATE TABLE "data_asset_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_asset_version_id" uuid NOT NULL,
	"netdrive_file_id" uuid,
	"location_id" uuid,
	"path" text NOT NULL,
	"digest" varchar(128) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"media_type" varchar(255),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "data_asset_files_size_bytes_check" CHECK ("data_asset_files"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "data_asset_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_asset_id" uuid NOT NULL,
	"target_version" varchar(128) NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"source_netdrive_file_id" uuid,
	"source_data_asset_version_id" uuid,
	"source_managed_root_id" uuid,
	"source_relative_path" text,
	"requester_user_id" uuid NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "data_asset_imports_source_kind_check" CHECK ("data_asset_imports"."source_kind" IN ('netdrive', 'data-market', 'cp-local')),
	CONSTRAINT "data_asset_imports_source_check" CHECK (("data_asset_imports"."source_kind" = 'netdrive' AND "data_asset_imports"."source_netdrive_file_id" IS NOT NULL AND "data_asset_imports"."source_data_asset_version_id" IS NULL AND "data_asset_imports"."source_managed_root_id" IS NULL AND "data_asset_imports"."source_relative_path" IS NULL) OR ("data_asset_imports"."source_kind" = 'data-market' AND "data_asset_imports"."source_netdrive_file_id" IS NULL AND "data_asset_imports"."source_data_asset_version_id" IS NOT NULL AND "data_asset_imports"."source_managed_root_id" IS NULL AND "data_asset_imports"."source_relative_path" IS NULL) OR ("data_asset_imports"."source_kind" = 'cp-local' AND "data_asset_imports"."source_netdrive_file_id" IS NULL AND "data_asset_imports"."source_data_asset_version_id" IS NULL AND "data_asset_imports"."source_managed_root_id" IS NOT NULL AND "data_asset_imports"."source_relative_path" IS NOT NULL)),
	CONSTRAINT "data_asset_imports_status_check" CHECK ("data_asset_imports"."status" IN ('pending', 'running', 'completed', 'failed', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "data_asset_manifest_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_asset_version_id" uuid NOT NULL,
	"data_asset_file_id" uuid,
	"entry_path" text NOT NULL,
	"digest" varchar(128) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"media_type" varchar(255),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "data_asset_manifest_entries_size_bytes_check" CHECK ("data_asset_manifest_entries"."size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "data_asset_versions" DROP CONSTRAINT "data_asset_versions_status_check";--> statement-breakpoint
ALTER TABLE "data_asset_versions" DROP CONSTRAINT "data_asset_versions_immutable_status_check";--> statement-breakpoint
ALTER TABLE "data_assets" DROP CONSTRAINT "data_assets_kind_check";--> statement-breakpoint
ALTER TABLE "data_assets" DROP CONSTRAINT "data_assets_lifecycle_check";--> statement-breakpoint
ALTER TABLE "data_assets" DROP CONSTRAINT "data_assets_visibility_check";--> statement-breakpoint
ALTER TABLE "data_locations" DROP CONSTRAINT "data_locations_kind_check";--> statement-breakpoint
ALTER TABLE "data_assets" ALTER COLUMN "kind" SET DEFAULT 'scientific-dataset';--> statement-breakpoint
ALTER TABLE "data_locations" ALTER COLUMN "uri" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD COLUMN "access_mode" varchar(32) DEFAULT 'request' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD COLUMN "sensitivity" varchar(32) DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD COLUMN "download_policy" varchar(16) DEFAULT 'deny' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD COLUMN "derive_policy" varchar(16) DEFAULT 'deny' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD COLUMN "redistribution_policy" varchar(16) DEFAULT 'deny' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD COLUMN "cross_center_replication_policy" varchar(16) DEFAULT 'deny' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD COLUMN "retention_policy" varchar(32) DEFAULT 'source-controlled' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "data_asset_versions" ADD COLUMN "manifest_digest" varchar(128);--> statement-breakpoint
ALTER TABLE "data_assets" ADD COLUMN "owner_kind" varchar(32) DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_assets" ADD COLUMN "access_mode" varchar(32) DEFAULT 'request' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_assets" ADD COLUMN "sensitivity" varchar(32) DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_locations" ADD COLUMN "managed_root_id" uuid;--> statement-breakpoint
ALTER TABLE "data_locations" ADD COLUMN "relative_path" text;--> statement-breakpoint
ALTER TABLE "data_asset_files" ADD CONSTRAINT "data_asset_files_data_asset_version_id_data_asset_versions_id_fk" FOREIGN KEY ("data_asset_version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_asset_files" ADD CONSTRAINT "data_asset_files_netdrive_file_id_netdrive_files_id_fk" FOREIGN KEY ("netdrive_file_id") REFERENCES "public"."netdrive_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_asset_files" ADD CONSTRAINT "data_asset_files_location_id_data_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."data_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_asset_imports" ADD CONSTRAINT "data_asset_imports_target_asset_id_data_assets_id_fk" FOREIGN KEY ("target_asset_id") REFERENCES "public"."data_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_asset_imports" ADD CONSTRAINT "data_asset_imports_source_netdrive_file_id_netdrive_files_id_fk" FOREIGN KEY ("source_netdrive_file_id") REFERENCES "public"."netdrive_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_asset_imports" ADD CONSTRAINT "data_asset_imports_source_data_asset_version_id_data_asset_versions_id_fk" FOREIGN KEY ("source_data_asset_version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_asset_imports" ADD CONSTRAINT "data_asset_imports_source_managed_root_id_cluster_file_roots_id_fk" FOREIGN KEY ("source_managed_root_id") REFERENCES "public"."cluster_file_roots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_asset_imports" ADD CONSTRAINT "data_asset_imports_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_asset_manifest_entries" ADD CONSTRAINT "data_asset_manifest_entries_data_asset_version_id_data_asset_versions_id_fk" FOREIGN KEY ("data_asset_version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_asset_manifest_entries" ADD CONSTRAINT "data_asset_manifest_entries_data_asset_file_id_data_asset_files_id_fk" FOREIGN KEY ("data_asset_file_id") REFERENCES "public"."data_asset_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_asset_files_version_path_idx" ON "data_asset_files" USING btree ("data_asset_version_id","path");--> statement-breakpoint
CREATE INDEX "data_asset_files_location_idx" ON "data_asset_files" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "data_asset_files_netdrive_idx" ON "data_asset_files" USING btree ("netdrive_file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_asset_imports_requester_key_idx" ON "data_asset_imports" USING btree ("requester_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "data_asset_imports_target_idx" ON "data_asset_imports" USING btree ("target_asset_id","target_version");--> statement-breakpoint
CREATE INDEX "data_asset_imports_status_idx" ON "data_asset_imports" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_asset_manifest_entries_version_entry_idx" ON "data_asset_manifest_entries" USING btree ("data_asset_version_id","entry_path");--> statement-breakpoint
CREATE INDEX "data_asset_manifest_entries_file_idx" ON "data_asset_manifest_entries" USING btree ("data_asset_file_id");--> statement-breakpoint
ALTER TABLE "data_locations" ADD CONSTRAINT "data_locations_managed_root_id_cluster_file_roots_id_fk" FOREIGN KEY ("managed_root_id") REFERENCES "public"."cluster_file_roots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_locations_version_root_path_idx" ON "data_locations" USING btree ("data_asset_version_id","managed_root_id","relative_path");--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD CONSTRAINT "data_access_policies_access_mode_check" CHECK ("data_access_policies"."access_mode" IN ('open', 'request', 'entitlement'));--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD CONSTRAINT "data_access_policies_sensitivity_check" CHECK ("data_access_policies"."sensitivity" IN ('open', 'internal', 'restricted', 'regulated'));--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD CONSTRAINT "data_access_policies_download_policy_check" CHECK ("data_access_policies"."download_policy" IN ('allow', 'deny'));--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD CONSTRAINT "data_access_policies_derive_policy_check" CHECK ("data_access_policies"."derive_policy" IN ('allow', 'deny'));--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD CONSTRAINT "data_access_policies_redistribution_policy_check" CHECK ("data_access_policies"."redistribution_policy" IN ('allow', 'deny'));--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD CONSTRAINT "data_access_policies_cross_center_replication_policy_check" CHECK ("data_access_policies"."cross_center_replication_policy" IN ('allow', 'deny'));--> statement-breakpoint
ALTER TABLE "data_access_policies" ADD CONSTRAINT "data_access_policies_retention_policy_check" CHECK ("data_access_policies"."retention_policy" IN ('source-controlled', 'retain', 'delete-on-expiry'));--> statement-breakpoint
ALTER TABLE "data_asset_versions" ADD CONSTRAINT "data_asset_versions_status_check" CHECK ("data_asset_versions"."status" IN ('draft', 'validating', 'ready', 'failed', 'deprecated', 'revoked'));--> statement-breakpoint
ALTER TABLE "data_asset_versions" ADD CONSTRAINT "data_asset_versions_immutable_status_check" CHECK ("data_asset_versions"."status" IN ('draft', 'validating', 'failed') OR "data_asset_versions"."immutable_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "data_assets" ADD CONSTRAINT "data_assets_access_mode_check" CHECK ("data_assets"."access_mode" IN ('open', 'request', 'entitlement'));--> statement-breakpoint
ALTER TABLE "data_assets" ADD CONSTRAINT "data_assets_sensitivity_check" CHECK ("data_assets"."sensitivity" IN ('open', 'internal', 'restricted', 'regulated'));--> statement-breakpoint
ALTER TABLE "data_assets" ADD CONSTRAINT "data_assets_owner_check" CHECK (("data_assets"."owner_kind" = 'user' AND "data_assets"."owner_user_id" IS NOT NULL AND "data_assets"."owner_org_id" IS NULL AND "data_assets"."provider_org_id" IS NULL) OR ("data_assets"."owner_kind" = 'org' AND "data_assets"."owner_user_id" IS NULL AND "data_assets"."owner_org_id" IS NOT NULL AND "data_assets"."provider_org_id" IS NULL) OR ("data_assets"."owner_kind" = 'provider' AND "data_assets"."owner_user_id" IS NULL AND "data_assets"."owner_org_id" IS NULL AND "data_assets"."provider_org_id" IS NOT NULL) OR ("data_assets"."owner_kind" = 'platform' AND "data_assets"."owner_user_id" IS NULL AND "data_assets"."owner_org_id" IS NULL AND "data_assets"."provider_org_id" IS NULL));--> statement-breakpoint
ALTER TABLE "data_assets" ADD CONSTRAINT "data_assets_kind_check" CHECK ("data_assets"."kind" IN ('training-dataset', 'scientific-dataset', 'reference-data', 'model-artifact', 'pseudopotential', 'licensed-material'));--> statement-breakpoint
ALTER TABLE "data_assets" ADD CONSTRAINT "data_assets_lifecycle_check" CHECK ("data_assets"."lifecycle" IN ('draft', 'reviewing', 'published', 'deprecated', 'revoked'));--> statement-breakpoint
ALTER TABLE "data_assets" ADD CONSTRAINT "data_assets_visibility_check" CHECK ("data_assets"."visibility" IN ('public', 'organization', 'private'));--> statement-breakpoint
ALTER TABLE "data_locations" ADD CONSTRAINT "data_locations_source_check" CHECK (("data_locations"."kind" = 'cp-local' AND "data_locations"."managed_root_id" IS NOT NULL AND "data_locations"."relative_path" IS NOT NULL AND "data_locations"."uri" IS NULL) OR ("data_locations"."kind" IN ('platform-object', 'user-private-object') AND "data_locations"."uri" IS NOT NULL AND "data_locations"."managed_root_id" IS NULL AND "data_locations"."relative_path" IS NULL));--> statement-breakpoint
ALTER TABLE "data_locations" ADD CONSTRAINT "data_locations_kind_check" CHECK ("data_locations"."kind" IN ('platform-object', 'user-private-object', 'cp-local'));