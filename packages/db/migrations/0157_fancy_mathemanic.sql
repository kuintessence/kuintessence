CREATE TABLE "federation_media_exports" (
	"local_site_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"recipient_site_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"source" jsonb NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_digest" varchar(71) NOT NULL,
	"manifest_jws" text NOT NULL,
	"recipient" varchar(62) NOT NULL,
	"identity_encrypted" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	CONSTRAINT "federation_media_exports_local_site_id_package_id_pk" PRIMARY KEY("local_site_id","package_id"),
	CONSTRAINT "federation_media_export_identity" CHECK ((
      "federation_media_exports"."manifest"->>'kind' = 'media-manifest'
      AND "federation_media_exports"."manifest"->>'packageId' = "federation_media_exports"."package_id"::text
      AND "federation_media_exports"."manifest"->>'senderSiteId' = "federation_media_exports"."local_site_id"::text
      AND "federation_media_exports"."manifest"->>'recipientSiteId' = "federation_media_exports"."recipient_site_id"::text
      AND "federation_media_exports"."manifest"->>'agreementRevisionId' = "federation_media_exports"."agreement_revision_id"::text
      AND "federation_media_exports"."local_site_id" <> "federation_media_exports"."recipient_site_id"
      AND "federation_media_exports"."manifest_digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_media_exports"."recipient" ~ '^age1[0-9a-z]{58}$'
      AND octet_length("federation_media_exports"."identity_encrypted") BETWEEN 1 AND 1024
      AND "federation_media_exports"."expires_at" > "federation_media_exports"."approved_at"
      AND "federation_media_exports"."expires_at" <= "federation_media_exports"."approved_at" + interval '7 days'
      AND (("federation_media_exports"."revoked_at" IS NULL) = ("federation_media_exports"."revocation_reason" IS NULL))) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD CONSTRAINT "federation_media_exports_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD CONSTRAINT "federation_media_exports_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD CONSTRAINT "federation_media_exports_recipient_site_id_federation_sites_id_fk" FOREIGN KEY ("recipient_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD CONSTRAINT "federation_media_exports_agreement_revision_id_federation_agreements_revision_id_fk" FOREIGN KEY ("agreement_revision_id") REFERENCES "public"."federation_agreements"("revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD CONSTRAINT "federation_media_exports_version_id_data_asset_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD CONSTRAINT "federation_media_exports_location_id_data_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."data_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_exports" ADD CONSTRAINT "federation_media_exports_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_media_export_org" ON "federation_media_exports" USING btree ("local_site_id","local_org_id","approved_at");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'asset.read', 'asset.map', 'media.import', 'media.export', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));