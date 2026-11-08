CREATE TABLE "federation_dataset_assets" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"source_site_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	CONSTRAINT "federation_dataset_asset_sites" CHECK ("federation_dataset_assets"."local_site_id" <> "federation_dataset_assets"."source_site_id")
);
--> statement-breakpoint
CREATE TABLE "federation_dataset_replicas" (
	"replica_id" uuid PRIMARY KEY NOT NULL,
	"asset_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"import_generation" uuid NOT NULL,
	"source_policy_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"reference" jsonb NOT NULL,
	"lease" jsonb,
	"renew_after" timestamp with time zone NOT NULL,
	"renew_token" uuid,
	"last_error" varchar(32),
	"published_by" uuid NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	CONSTRAINT "federation_dataset_replicas_location_id_unique" UNIQUE("location_id"),
	CONSTRAINT "federation_dataset_replicas_authorization_id_unique" UNIQUE("authorization_id"),
	CONSTRAINT "federation_dataset_replica_reference" CHECK (("federation_dataset_replicas"."reference"->>'kind' = 'dataset') IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_dataset_assets" ADD CONSTRAINT "federation_dataset_assets_asset_id_data_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."data_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_assets" ADD CONSTRAINT "federation_dataset_assets_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_assets" ADD CONSTRAINT "federation_dataset_assets_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_assets" ADD CONSTRAINT "federation_dataset_assets_source_site_id_federation_sites_id_fk" FOREIGN KEY ("source_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_replicas" ADD CONSTRAINT "federation_dataset_replicas_asset_id_federation_dataset_assets_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."federation_dataset_assets"("asset_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_replicas" ADD CONSTRAINT "federation_dataset_replicas_version_id_data_asset_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_replicas" ADD CONSTRAINT "federation_dataset_replicas_location_id_data_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."data_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_replicas" ADD CONSTRAINT "federation_dataset_replicas_authorization_id_federation_media_import_authorizations_authorization_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."federation_media_import_authorizations"("authorization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_replicas" ADD CONSTRAINT "federation_dataset_replicas_agreement_revision_id_federation_agreements_revision_id_fk" FOREIGN KEY ("agreement_revision_id") REFERENCES "public"."federation_agreements"("revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_replicas" ADD CONSTRAINT "federation_dataset_replicas_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_dataset_asset_origin" ON "federation_dataset_assets" USING btree ("local_site_id","local_org_id","source_site_id","source_asset_id");--> statement-breakpoint
CREATE INDEX "federation_dataset_replica_renewal" ON "federation_dataset_replicas" USING btree ("renew_after");