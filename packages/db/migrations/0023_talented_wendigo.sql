CREATE TABLE "account_assignment_delegations" (
	"provider_org_id" uuid PRIMARY KEY NOT NULL,
	"delegated" boolean DEFAULT false NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_replicas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"site_id" varchar(255) NOT NULL,
	"cluster_id" varchar(255) NOT NULL,
	"storage_kind" varchar(20) NOT NULL,
	"storage_ref" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp,
	"expires_at" timestamp,
	"failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_replicas_storage_kind_check" CHECK ("artifact_replicas"."storage_kind" IN ('agent-local', 'netdrive')),
	CONSTRAINT "artifact_replicas_status_check" CHECK ("artifact_replicas"."status" IN ('pending', 'available', 'persisting', 'failed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "cluster_execution_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"backend_type" varchar(20) NOT NULL,
	"username" varchar(255),
	"uid" integer,
	"gid" integer,
	"scheduler_account" varchar(255),
	"allowed_queues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"namespace" varchar(255),
	"service_account" varchar(255),
	"quota_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"shared_service" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cluster_execution_accounts_backend_check" CHECK (("cluster_execution_accounts"."backend_type" = 'unix' AND "cluster_execution_accounts"."username" IS NOT NULL AND "cluster_execution_accounts"."uid" > 0 AND "cluster_execution_accounts"."gid" > 0) OR ("cluster_execution_accounts"."backend_type" = 'kubernetes' AND "cluster_execution_accounts"."namespace" IS NOT NULL AND "cluster_execution_accounts"."service_account" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "placement_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"planner_mode" varchar(20) NOT NULL,
	"trigger" varchar(100) NOT NULL,
	"nodes" jsonb NOT NULL,
	"objective" jsonb NOT NULL,
	"budget_cap" double precision,
	"budget_status" varchar(32) DEFAULT 'within-cap' NOT NULL,
	"supersedes_plan_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "placement_plans_mode_check" CHECK ("placement_plans"."planner_mode" IN ('Global', 'Lookahead', 'Greedy')),
	CONSTRAINT "placement_plans_budget_status_check" CHECK ("placement_plans"."budget_status" IN ('within-cap', 'awaiting-approval', 'approved'))
);
--> statement-breakpoint
CREATE TABLE "sandbox_policy_overlays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" varchar(20) NOT NULL,
	"provider_org_id" uuid,
	"cluster_id" varchar(255),
	"agent_id" varchar(255),
	"policy" jsonb NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_policy_overlays_scope_check" CHECK ("sandbox_policy_overlays"."scope" IN ('platform', 'provider', 'cluster', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "sandbox_runtime_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"language" varchar(20) NOT NULL,
	"language_version" varchar(100) NOT NULL,
	"oci_digest" varchar(71),
	"sif_digest" varchar(71),
	"signature" text NOT NULL,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"documentation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"adapters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"security_requirements" jsonb NOT NULL,
	"lifecycle" varchar(20) DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_runtime_profiles_language_check" CHECK ("sandbox_runtime_profiles"."language" IN ('python', 'nodejs', 'bash')),
	CONSTRAINT "sandbox_runtime_profiles_lifecycle_check" CHECK ("sandbox_runtime_profiles"."lifecycle" IN ('draft', 'active', 'deprecated', 'revoked')),
	CONSTRAINT "sandbox_runtime_profiles_digest_check" CHECK ("sandbox_runtime_profiles"."oci_digest" IS NOT NULL OR "sandbox_runtime_profiles"."sif_digest" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "script_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_revision_id" uuid NOT NULL,
	"script_sha256" varchar(64) NOT NULL,
	"runtime_profile_id" uuid NOT NULL,
	"runtime_digest" varchar(71) NOT NULL,
	"scope" varchar(20) NOT NULL,
	"provider_org_id" uuid,
	"scan_result_hash" varchar(64) NOT NULL,
	"allowed_identities" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"signed_by" uuid NOT NULL,
	"signed_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	CONSTRAINT "script_attestations_scope_check" CHECK (("script_attestations"."scope" = 'platform' AND "script_attestations"."provider_org_id" IS NULL) OR ("script_attestations"."scope" = 'provider' AND "script_attestations"."provider_org_id" IS NOT NULL)),
	CONSTRAINT "script_attestations_status_check" CHECK ("script_attestations"."status" IN ('active', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "script_execution_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_revision_id" uuid,
	"inline_script_hash" varchar(64),
	"runtime_profile_id" uuid NOT NULL,
	"input_size_bucket" varchar(32) NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"average_output_bytes" double precision DEFAULT 0 NOT NULL,
	"average_output_ratio" double precision DEFAULT 0 NOT NULL,
	"average_prediction_error" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "script_execution_stats_source_check" CHECK (("script_execution_stats"."asset_revision_id" IS NOT NULL AND "script_execution_stats"."inline_script_hash" IS NULL) OR ("script_execution_stats"."asset_revision_id" IS NULL AND "script_execution_stats"."inline_script_hash" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "user_cluster_account_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_at" timestamp,
	"reviewed_by" uuid,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	CONSTRAINT "user_cluster_account_mappings_status_check" CHECK ("user_cluster_account_mappings"."status" IN ('pending', 'approved', 'rejected', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "workflow_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"producer_node_id" varchar(255) NOT NULL,
	"descriptor" varchar(255) NOT NULL,
	"io_type" varchar(20) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"durability" varchar(20) NOT NULL,
	"netdrive_file_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"persistent_at" timestamp,
	CONSTRAINT "workflow_artifacts_io_type_check" CHECK ("workflow_artifacts"."io_type" IN ('Text', 'JSON', 'File', 'FileBatch')),
	CONSTRAINT "workflow_artifacts_durability_check" CHECK ("workflow_artifacts"."durability" IN ('Ephemeral', 'Checkpoint', 'Persistent'))
);
--> statement-breakpoint
ALTER TABLE "software_assets" DROP CONSTRAINT "software_assets_kind_check";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "root_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "sandbox_readiness" varchar(20) DEFAULT 'critical' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "sandbox_capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "sandbox_runtime_cache" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "account_assignment_delegations" ADD CONSTRAINT "account_assignment_delegations_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_assignment_delegations" ADD CONSTRAINT "account_assignment_delegations_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_replicas" ADD CONSTRAINT "artifact_replicas_artifact_id_workflow_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."workflow_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_replicas" ADD CONSTRAINT "artifact_replicas_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_execution_accounts" ADD CONSTRAINT "cluster_execution_accounts_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_execution_accounts" ADD CONSTRAINT "cluster_execution_accounts_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_execution_accounts" ADD CONSTRAINT "cluster_execution_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_plans" ADD CONSTRAINT "placement_plans_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_policy_overlays" ADD CONSTRAINT "sandbox_policy_overlays_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_policy_overlays" ADD CONSTRAINT "sandbox_policy_overlays_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_policy_overlays" ADD CONSTRAINT "sandbox_policy_overlays_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_runtime_profiles" ADD CONSTRAINT "sandbox_runtime_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_attestations" ADD CONSTRAINT "script_attestations_asset_revision_id_software_asset_revisions_id_fk" FOREIGN KEY ("asset_revision_id") REFERENCES "public"."software_asset_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_attestations" ADD CONSTRAINT "script_attestations_runtime_profile_id_sandbox_runtime_profiles_id_fk" FOREIGN KEY ("runtime_profile_id") REFERENCES "public"."sandbox_runtime_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_attestations" ADD CONSTRAINT "script_attestations_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_attestations" ADD CONSTRAINT "script_attestations_signed_by_users_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_execution_stats" ADD CONSTRAINT "script_execution_stats_asset_revision_id_software_asset_revisions_id_fk" FOREIGN KEY ("asset_revision_id") REFERENCES "public"."software_asset_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_execution_stats" ADD CONSTRAINT "script_execution_stats_runtime_profile_id_sandbox_runtime_profiles_id_fk" FOREIGN KEY ("runtime_profile_id") REFERENCES "public"."sandbox_runtime_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_cluster_account_mappings" ADD CONSTRAINT "user_cluster_account_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_cluster_account_mappings" ADD CONSTRAINT "user_cluster_account_mappings_account_id_cluster_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cluster_execution_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_cluster_account_mappings" ADD CONSTRAINT "user_cluster_account_mappings_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_artifacts" ADD CONSTRAINT "workflow_artifacts_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_artifacts" ADD CONSTRAINT "workflow_artifacts_netdrive_file_id_netdrive_files_id_fk" FOREIGN KEY ("netdrive_file_id") REFERENCES "public"."netdrive_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_replicas_artifact_agent_idx" ON "artifact_replicas" USING btree ("artifact_id","agent_id","storage_kind");--> statement-breakpoint
CREATE INDEX "artifact_replicas_locality_status_idx" ON "artifact_replicas" USING btree ("site_id","cluster_id","status");--> statement-breakpoint
CREATE INDEX "artifact_replicas_expiry_idx" ON "artifact_replicas" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "cluster_execution_accounts_provider_agent_idx" ON "cluster_execution_accounts" USING btree ("provider_org_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_execution_accounts_unix_identity_idx" ON "cluster_execution_accounts" USING btree ("agent_id","uid");--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_execution_accounts_k8s_identity_idx" ON "cluster_execution_accounts" USING btree ("agent_id","namespace","service_account");--> statement-breakpoint
CREATE UNIQUE INDEX "placement_plans_run_version_idx" ON "placement_plans" USING btree ("workflow_run_id","version");--> statement-breakpoint
CREATE INDEX "placement_plans_run_created_idx" ON "placement_plans" USING btree ("workflow_run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_policy_overlays_platform_scope_idx" ON "sandbox_policy_overlays" USING btree ("scope") WHERE "sandbox_policy_overlays"."scope" = 'platform';--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_policy_overlays_provider_scope_idx" ON "sandbox_policy_overlays" USING btree ("provider_org_id") WHERE "sandbox_policy_overlays"."scope" = 'provider';--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_policy_overlays_cluster_scope_idx" ON "sandbox_policy_overlays" USING btree ("provider_org_id","cluster_id") WHERE "sandbox_policy_overlays"."scope" = 'cluster';--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_policy_overlays_agent_scope_idx" ON "sandbox_policy_overlays" USING btree ("agent_id") WHERE "sandbox_policy_overlays"."scope" = 'agent';--> statement-breakpoint
CREATE INDEX "sandbox_policy_overlays_provider_idx" ON "sandbox_policy_overlays" USING btree ("provider_org_id");--> statement-breakpoint
CREATE INDEX "sandbox_policy_overlays_agent_idx" ON "sandbox_policy_overlays" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "sandbox_runtime_profiles_language_lifecycle_idx" ON "sandbox_runtime_profiles" USING btree ("language","lifecycle");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_runtime_profiles_oci_digest_idx" ON "sandbox_runtime_profiles" USING btree ("oci_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_runtime_profiles_sif_digest_idx" ON "sandbox_runtime_profiles" USING btree ("sif_digest");--> statement-breakpoint
CREATE INDEX "script_attestations_revision_scope_idx" ON "script_attestations" USING btree ("asset_revision_id","scope","provider_org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "script_execution_stats_revision_runtime_bucket_idx" ON "script_execution_stats" USING btree ("asset_revision_id","runtime_profile_id","input_size_bucket") WHERE "script_execution_stats"."asset_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "script_execution_stats_inline_runtime_bucket_idx" ON "script_execution_stats" USING btree ("inline_script_hash","runtime_profile_id","input_size_bucket") WHERE "script_execution_stats"."inline_script_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_cluster_account_mappings_user_account_idx" ON "user_cluster_account_mappings" USING btree ("user_id","account_id");--> statement-breakpoint
CREATE INDEX "user_cluster_account_mappings_user_status_idx" ON "user_cluster_account_mappings" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_artifacts_run_node_descriptor_idx" ON "workflow_artifacts" USING btree ("workflow_run_id","producer_node_id","descriptor");--> statement-breakpoint
CREATE INDEX "workflow_artifacts_hash_idx" ON "workflow_artifacts" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "workflow_artifacts_durability_idx" ON "workflow_artifacts" USING btree ("durability","created_at");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_sandbox_readiness_check" CHECK ("agents"."sandbox_readiness" IN ('ready', 'degraded', 'critical'));--> statement-breakpoint
ALTER TABLE "software_assets" ADD CONSTRAINT "software_assets_kind_check" CHECK ("software_assets"."kind" IN ('spack-package', 'usecase', 'workflow-template', 'sandbox-script'));