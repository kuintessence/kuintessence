CREATE TABLE "federation_media_import_authorizations" (
	"authorization_id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"managed_root_id" uuid NOT NULL,
	"max_bytes" bigint NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	CONSTRAINT "federation_media_import_limits" CHECK ((
      "federation_media_import_authorizations"."max_bytes" BETWEEN 0 AND 5497558138880
      AND "federation_media_import_authorizations"."expires_at" > "federation_media_import_authorizations"."approved_at"
      AND "federation_media_import_authorizations"."expires_at" <= "federation_media_import_authorizations"."approved_at" + interval '7 days'
      AND (("federation_media_import_authorizations"."revoked_at" IS NULL) = ("federation_media_import_authorizations"."revocation_reason" IS NULL))) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_media_packages" (
	"local_site_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"sender_site_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_digest" varchar(71) NOT NULL,
	"manifest_jws" text NOT NULL,
	"registered_by" uuid NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	CONSTRAINT "federation_media_packages_local_site_id_package_id_pk" PRIMARY KEY("local_site_id","package_id"),
	CONSTRAINT "federation_media_package_identity" CHECK ((
      "federation_media_packages"."manifest"->>'kind' = 'media-manifest'
      AND "federation_media_packages"."manifest"->>'packageId' = "federation_media_packages"."package_id"::text
      AND "federation_media_packages"."manifest"->>'senderSiteId' = "federation_media_packages"."sender_site_id"::text
      AND "federation_media_packages"."manifest"->>'recipientSiteId' = "federation_media_packages"."local_site_id"::text
      AND "federation_media_packages"."manifest"->>'agreementRevisionId' = "federation_media_packages"."agreement_revision_id"::text
      AND "federation_media_packages"."sender_site_id" <> "federation_media_packages"."local_site_id"
      AND "federation_media_packages"."manifest_digest" ~ '^sha256:[a-f0-9]{64}$'
      AND octet_length("federation_media_packages"."manifest_jws") BETWEEN 1 AND 524288
      AND (("federation_media_packages"."revoked_at" IS NULL) = ("federation_media_packages"."revocation_reason" IS NULL))) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_media_import_authorizations" ADD CONSTRAINT "federation_media_import_authorizations_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_import_authorizations" ADD CONSTRAINT "federation_media_import_authorizations_managed_root_id_cluster_file_roots_id_fk" FOREIGN KEY ("managed_root_id") REFERENCES "public"."cluster_file_roots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_import_authorizations" ADD CONSTRAINT "federation_media_import_authorizations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_import_authorizations" ADD CONSTRAINT "federation_media_import_authorizations_local_site_id_package_id_federation_media_packages_local_site_id_package_id_fk" FOREIGN KEY ("local_site_id","package_id") REFERENCES "public"."federation_media_packages"("local_site_id","package_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_packages" ADD CONSTRAINT "federation_media_packages_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_packages" ADD CONSTRAINT "federation_media_packages_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_packages" ADD CONSTRAINT "federation_media_packages_sender_site_id_federation_sites_id_fk" FOREIGN KEY ("sender_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_packages" ADD CONSTRAINT "federation_media_packages_agreement_revision_id_federation_agreements_revision_id_fk" FOREIGN KEY ("agreement_revision_id") REFERENCES "public"."federation_agreements"("revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_packages" ADD CONSTRAINT "federation_media_packages_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_media_import_package" ON "federation_media_import_authorizations" USING btree ("local_site_id","package_id","approved_at");--> statement-breakpoint
CREATE INDEX "federation_media_package_org" ON "federation_media_packages" USING btree ("local_site_id","local_org_id","registered_at");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'asset.read', 'asset.map', 'media.import', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));