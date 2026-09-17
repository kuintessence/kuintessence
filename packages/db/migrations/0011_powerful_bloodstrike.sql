CREATE TABLE "preinstalled_software_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"local_spec" varchar(500) NOT NULL,
	"asset_id" uuid NOT NULL,
	"confidence" varchar(32) DEFAULT 'declared' NOT NULL,
	"audited_by" uuid,
	"audited_at" timestamp,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "preinstalled_software_mappings_confidence_check" CHECK ("preinstalled_software_mappings"."confidence" IN ('declared', 'metadata-match', 'hash-match', 'platform-locked'))
);
--> statement-breakpoint
CREATE TABLE "software_asset_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"subject_kind" varchar(32) NOT NULL,
	"subject_id" varchar(255) NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inherited_from_asset_id" uuid,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "software_asset_grants_subject_check" CHECK ("software_asset_grants"."subject_kind" IN ('user', 'org', 'provider-org', 'platform'))
);
--> statement-breakpoint
CREATE TABLE "software_asset_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recipe_sha256" varchar(64),
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "software_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(32) NOT NULL,
	"name" varchar(255) NOT NULL,
	"version" varchar(100) NOT NULL,
	"source" varchar(64) NOT NULL,
	"lifecycle" varchar(32) DEFAULT 'draft' NOT NULL,
	"visibility" varchar(32) DEFAULT 'private' NOT NULL,
	"owner_user_id" uuid,
	"owner_org_id" uuid,
	"provider_org_id" uuid,
	"supplier_user_id" uuid,
	"supplier_org_id" uuid,
	"official_fork_of_asset_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trusted_for_global_use" boolean DEFAULT false NOT NULL,
	"review_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "software_assets_kind_check" CHECK ("software_assets"."kind" IN ('spack-package', 'usecase', 'workflow-template')),
	CONSTRAINT "software_assets_lifecycle_check" CHECK ("software_assets"."lifecycle" IN ('draft', 'submitted', 'approved', 'forked', 'published', 'hidden', 'deprecated', 'revoked', 'archived')),
	CONSTRAINT "software_assets_visibility_check" CHECK ("software_assets"."visibility" IN ('private', 'shared-to-orgs', 'platform-public', 'pending-review', 'hidden')),
	CONSTRAINT "software_assets_source_check" CHECK ("software_assets"."source" IN ('official-upstream', 'platform-fork', 'cp-private', 'cp-shared', 'sp-draft', 'sp-published'))
);
--> statement-breakpoint
CREATE TABLE "software_concretize_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid,
	"root_spec" varchar(500) NOT NULL,
	"context_key" varchar(255) NOT NULL,
	"dag" jsonb NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "software_mirror_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid,
	"kind" varchar(32) NOT NULL,
	"status" varchar(32) DEFAULT 'missing' NOT NULL,
	"source_url" text,
	"local_url" text,
	"sha256" varchar(64),
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cached_at" timestamp,
	"error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "software_mirror_cache_kind_check" CHECK ("software_mirror_cache"."kind" IN ('recipe', 'metadata', 'source', 'buildcache')),
	CONSTRAINT "software_mirror_cache_status_check" CHECK ("software_mirror_cache"."status" IN ('cached', 'missing', 'syncing', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "software_policy_overlays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" varchar(20) NOT NULL,
	"provider_org_id" uuid,
	"agent_id" varchar(255),
	"install_mode" varchar(64) DEFAULT 'explicit-install-grant' NOT NULL,
	"allow_list" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deny_list" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lock_enabled" boolean DEFAULT false NOT NULL,
	"trusted_public_auto_install" boolean DEFAULT false NOT NULL,
	"mirrors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preinstall_list" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" varchar(64) DEFAULT 'v0' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "software_policy_overlays_scope_check" CHECK ("software_policy_overlays"."scope" IN ('provider', 'agent')),
	CONSTRAINT "software_policy_overlays_install_mode_check" CHECK ("software_policy_overlays"."install_mode" IN ('preinstalled-only', 'trusted-public-auto-install', 'explicit-install-grant'))
);
--> statement-breakpoint
CREATE TABLE "user_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"capability" varchar(64) NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_capabilities_capability_check" CHECK ("user_capabilities"."capability" IN ('software_provider'))
);
--> statement-breakpoint
ALTER TABLE "preinstalled_software_mappings" ADD CONSTRAINT "preinstalled_software_mappings_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preinstalled_software_mappings" ADD CONSTRAINT "preinstalled_software_mappings_asset_id_software_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."software_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preinstalled_software_mappings" ADD CONSTRAINT "preinstalled_software_mappings_audited_by_users_id_fk" FOREIGN KEY ("audited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preinstalled_software_mappings" ADD CONSTRAINT "preinstalled_software_mappings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_asset_grants" ADD CONSTRAINT "software_asset_grants_asset_id_software_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."software_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_asset_grants" ADD CONSTRAINT "software_asset_grants_inherited_from_asset_id_software_assets_id_fk" FOREIGN KEY ("inherited_from_asset_id") REFERENCES "public"."software_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_asset_grants" ADD CONSTRAINT "software_asset_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_asset_revisions" ADD CONSTRAINT "software_asset_revisions_asset_id_software_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."software_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_asset_revisions" ADD CONSTRAINT "software_asset_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_assets" ADD CONSTRAINT "software_assets_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_assets" ADD CONSTRAINT "software_assets_owner_org_id_orgs_id_fk" FOREIGN KEY ("owner_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_assets" ADD CONSTRAINT "software_assets_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_assets" ADD CONSTRAINT "software_assets_supplier_user_id_users_id_fk" FOREIGN KEY ("supplier_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_assets" ADD CONSTRAINT "software_assets_supplier_org_id_orgs_id_fk" FOREIGN KEY ("supplier_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_assets" ADD CONSTRAINT "software_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_concretize_cache" ADD CONSTRAINT "software_concretize_cache_asset_id_software_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."software_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_mirror_cache" ADD CONSTRAINT "software_mirror_cache_asset_id_software_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."software_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_policy_overlays" ADD CONSTRAINT "software_policy_overlays_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_policy_overlays" ADD CONSTRAINT "software_policy_overlays_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_capabilities" ADD CONSTRAINT "user_capabilities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_capabilities" ADD CONSTRAINT "user_capabilities_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "preinstalled_software_mappings_agent_local_spec_idx" ON "preinstalled_software_mappings" USING btree ("agent_id","local_spec");--> statement-breakpoint
CREATE INDEX "preinstalled_software_mappings_asset_idx" ON "preinstalled_software_mappings" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "software_asset_grants_asset_subject_idx" ON "software_asset_grants" USING btree ("asset_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "software_asset_grants_subject_idx" ON "software_asset_grants" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "software_asset_revisions_asset_revision_idx" ON "software_asset_revisions" USING btree ("asset_id","revision");--> statement-breakpoint
CREATE INDEX "software_asset_revisions_asset_idx" ON "software_asset_revisions" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "software_assets_kind_name_version_idx" ON "software_assets" USING btree ("kind","name","version");--> statement-breakpoint
CREATE INDEX "software_assets_lifecycle_idx" ON "software_assets" USING btree ("lifecycle");--> statement-breakpoint
CREATE INDEX "software_assets_provider_idx" ON "software_assets" USING btree ("provider_org_id");--> statement-breakpoint
CREATE INDEX "software_assets_source_idx" ON "software_assets" USING btree ("source");--> statement-breakpoint
CREATE INDEX "software_assets_official_fork_idx" ON "software_assets" USING btree ("official_fork_of_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "software_concretize_cache_context_idx" ON "software_concretize_cache" USING btree ("root_spec","context_key");--> statement-breakpoint
CREATE INDEX "software_concretize_cache_asset_idx" ON "software_concretize_cache" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "software_mirror_cache_asset_kind_idx" ON "software_mirror_cache" USING btree ("asset_id","kind");--> statement-breakpoint
CREATE INDEX "software_mirror_cache_status_idx" ON "software_mirror_cache" USING btree ("status");--> statement-breakpoint
CREATE INDEX "software_policy_overlays_provider_idx" ON "software_policy_overlays" USING btree ("provider_org_id");--> statement-breakpoint
CREATE INDEX "software_policy_overlays_agent_idx" ON "software_policy_overlays" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "software_policy_overlays_scope_provider_agent_idx" ON "software_policy_overlays" USING btree ("scope","provider_org_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_capabilities_user_capability_idx" ON "user_capabilities" USING btree ("user_id","capability");