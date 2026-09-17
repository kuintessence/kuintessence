CREATE TABLE "ecosystem_release_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"ecosystem_key" varchar(255) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"name" varchar(255) NOT NULL,
	"version" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"license_policy" jsonb NOT NULL,
	"asset_id" uuid,
	"asset_revision_id" uuid,
	"materialized_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ecosystem_release_assets_materialization_check" CHECK (("ecosystem_release_assets"."asset_id" IS NULL AND "ecosystem_release_assets"."asset_revision_id" IS NULL AND "ecosystem_release_assets"."materialized_at" IS NULL) OR ("ecosystem_release_assets"."asset_id" IS NOT NULL AND "ecosystem_release_assets"."asset_revision_id" IS NOT NULL AND "ecosystem_release_assets"."materialized_at" IS NOT NULL)),
	CONSTRAINT "ecosystem_release_assets_kind_check" CHECK ("ecosystem_release_assets"."kind" IN ('spack-package', 'usecase', 'workflow-template', 'sandbox-script'))
);
--> statement-breakpoint
CREATE TABLE "ecosystem_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_key" varchar(255) NOT NULL,
	"version" varchar(100) NOT NULL,
	"artifact_digest" varchar(71) NOT NULL,
	"manifest" jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signature" text NOT NULL,
	"signing_key_id" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'staged' NOT NULL,
	"imported_by" varchar(255) NOT NULL,
	"imported_at" timestamp DEFAULT now() NOT NULL,
	"activated_by" varchar(255),
	"activated_at" timestamp,
	"deactivated_at" timestamp,
	"failure_reason" text,
	CONSTRAINT "ecosystem_releases_status_check" CHECK ("ecosystem_releases"."status" IN ('staged', 'active', 'inactive', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "license_entitlement_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"license_subject" varchar(255) NOT NULL,
	"asset_id" uuid,
	"entitlement" varchar(32) NOT NULL,
	"claimant_kind" varchar(20) NOT NULL,
	"claimant_id" varchar(255) NOT NULL,
	"provider_org_id" uuid,
	"evidence_reference" varchar(2048) NOT NULL,
	"evidence_summary" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"submitted_by" varchar(255) NOT NULL,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_by" varchar(255),
	"reviewed_at" timestamp,
	"decision_reason" text,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	CONSTRAINT "license_entitlement_claims_entitlement_check" CHECK ("license_entitlement_claims"."entitlement" IN ('provider-source-install', 'consumer-use')),
	CONSTRAINT "license_entitlement_claims_claimant_kind_check" CHECK ("license_entitlement_claims"."claimant_kind" IN ('org', 'user')),
	CONSTRAINT "license_entitlement_claims_status_check" CHECK ("license_entitlement_claims"."status" IN ('pending', 'approved', 'rejected', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "licensed_material_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"selector" varchar(255) NOT NULL,
	"material_name" varchar(255) NOT NULL,
	"material_version" varchar(100) NOT NULL,
	"element_set" jsonb NOT NULL,
	"fingerprint" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"audit_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "licensed_material_mappings_status_check" CHECK ("licensed_material_mappings"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "sandbox_runtime_contract_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"agent_id" varchar(255),
	"cluster_id" varchar(255),
	"runtime_contract_ref" varchar(255) NOT NULL,
	"runtime_profile_id" uuid NOT NULL,
	"runtime_digest" varchar(71) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"bound_by" varchar(255) NOT NULL,
	"bound_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "sandbox_runtime_contract_bindings_status_check" CHECK ("sandbox_runtime_contract_bindings"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "ecosystem_release_assets" ADD CONSTRAINT "ecosystem_release_assets_release_id_ecosystem_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."ecosystem_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_release_assets" ADD CONSTRAINT "ecosystem_release_assets_asset_id_software_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."software_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_release_assets" ADD CONSTRAINT "ecosystem_release_assets_asset_revision_id_software_asset_revisions_id_fk" FOREIGN KEY ("asset_revision_id") REFERENCES "public"."software_asset_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_entitlement_claims" ADD CONSTRAINT "license_entitlement_claims_asset_id_software_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."software_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_entitlement_claims" ADD CONSTRAINT "license_entitlement_claims_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licensed_material_mappings" ADD CONSTRAINT "licensed_material_mappings_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licensed_material_mappings" ADD CONSTRAINT "licensed_material_mappings_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_runtime_contract_bindings" ADD CONSTRAINT "sandbox_runtime_contract_bindings_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_runtime_contract_bindings" ADD CONSTRAINT "sandbox_runtime_contract_bindings_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_runtime_contract_bindings" ADD CONSTRAINT "sandbox_runtime_contract_bindings_runtime_profile_id_sandbox_runtime_profiles_id_fk" FOREIGN KEY ("runtime_profile_id") REFERENCES "public"."sandbox_runtime_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ecosystem_release_assets_release_key_idx" ON "ecosystem_release_assets" USING btree ("release_id","ecosystem_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ecosystem_release_assets_release_asset_idx" ON "ecosystem_release_assets" USING btree ("release_id","asset_id");--> statement-breakpoint
CREATE INDEX "ecosystem_release_assets_asset_revision_idx" ON "ecosystem_release_assets" USING btree ("asset_id","asset_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ecosystem_releases_key_version_idx" ON "ecosystem_releases" USING btree ("release_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "ecosystem_releases_artifact_digest_idx" ON "ecosystem_releases" USING btree ("artifact_digest");--> statement-breakpoint
CREATE INDEX "ecosystem_releases_key_status_idx" ON "ecosystem_releases" USING btree ("release_key","status");--> statement-breakpoint
CREATE INDEX "license_entitlement_claims_claimant_status_idx" ON "license_entitlement_claims" USING btree ("claimant_kind","claimant_id","status");--> statement-breakpoint
CREATE INDEX "license_entitlement_claims_subject_status_idx" ON "license_entitlement_claims" USING btree ("license_subject","status");--> statement-breakpoint
CREATE UNIQUE INDEX "licensed_material_mappings_provider_agent_selector_idx" ON "licensed_material_mappings" USING btree ("provider_org_id","agent_id","selector");--> statement-breakpoint
CREATE INDEX "licensed_material_mappings_lookup_idx" ON "licensed_material_mappings" USING btree ("provider_org_id","material_name","material_version","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_runtime_contract_bindings_scope_contract_idx" ON "sandbox_runtime_contract_bindings" USING btree ("provider_org_id","agent_id","cluster_id","runtime_contract_ref");--> statement-breakpoint
CREATE INDEX "sandbox_runtime_contract_bindings_lookup_idx" ON "sandbox_runtime_contract_bindings" USING btree ("provider_org_id","runtime_contract_ref","status");