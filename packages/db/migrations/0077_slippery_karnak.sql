CREATE TABLE "federation_asset_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_org_id" uuid NOT NULL,
	"origin_site_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"origin_id" uuid NOT NULL,
	"origin_revision" varchar(128) NOT NULL,
	"digest" varchar(71) NOT NULL,
	"software_revision_id" uuid,
	"data_version_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "federation_asset_digest" CHECK ("federation_asset_mappings"."digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "federation_asset_target" CHECK (("federation_asset_mappings"."kind" = 'dataset' AND "federation_asset_mappings"."data_version_id" IS NOT NULL AND "federation_asset_mappings"."software_revision_id" IS NULL)
    OR ("federation_asset_mappings"."kind" IN ('workflow', 'script', 'software', 'usecase') AND "federation_asset_mappings"."software_revision_id" IS NOT NULL AND "federation_asset_mappings"."data_version_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_materials" (
	"local_org_id" uuid NOT NULL,
	"origin_site_id" uuid NOT NULL,
	"digest" varchar(71) NOT NULL,
	"kind" varchar(24) NOT NULL,
	"content" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_materials_local_org_id_origin_site_id_digest_pk" PRIMARY KEY("local_org_id","origin_site_id","digest"),
	CONSTRAINT "federation_material_kind" CHECK ("federation_materials"."kind" IN ('inputs', 'environment-lock')),
	CONSTRAINT "federation_material_digest" CHECK ("federation_materials"."digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "federation_material_size" CHECK (octet_length("federation_materials"."content") <= 1048576)
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_asset_mappings" ADD CONSTRAINT "federation_asset_mappings_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_asset_mappings" ADD CONSTRAINT "federation_asset_mappings_origin_site_id_federation_sites_id_fk" FOREIGN KEY ("origin_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_asset_mappings" ADD CONSTRAINT "federation_asset_mappings_software_revision_id_software_asset_revisions_id_fk" FOREIGN KEY ("software_revision_id") REFERENCES "public"."software_asset_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_asset_mappings" ADD CONSTRAINT "federation_asset_mappings_data_version_id_data_asset_versions_id_fk" FOREIGN KEY ("data_version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_asset_mappings" ADD CONSTRAINT "federation_asset_mappings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_materials" ADD CONSTRAINT "federation_materials_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_materials" ADD CONSTRAINT "federation_materials_origin_site_id_federation_sites_id_fk" FOREIGN KEY ("origin_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_materials" ADD CONSTRAINT "federation_materials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_asset_origin" ON "federation_asset_mappings" USING btree ("local_org_id","origin_site_id","kind","origin_id","origin_revision");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'asset.read', 'asset.map'));