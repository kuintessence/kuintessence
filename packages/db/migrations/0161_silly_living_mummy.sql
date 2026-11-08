CREATE TABLE "federation_dataset_use_grants" (
	"local_site_id" uuid NOT NULL,
	"query_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"query_digest" varchar(71) NOT NULL,
	"response_jws" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "federation_dataset_use_grants_local_site_id_query_id_pk" PRIMARY KEY("local_site_id","query_id"),
	CONSTRAINT "federation_dataset_use_grant_window" CHECK ("federation_dataset_use_grants"."expires_at" > "federation_dataset_use_grants"."issued_at" AND "federation_dataset_use_grants"."expires_at" <= "federation_dataset_use_grants"."issued_at" + interval '60 seconds'),
	CONSTRAINT "federation_dataset_use_grant_digest" CHECK ("federation_dataset_use_grants"."query_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "federation_dataset_use_policies" (
	"local_site_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"recipient_site_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"asset" jsonb NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	CONSTRAINT "federation_dataset_use_policies_local_site_id_policy_id_pk" PRIMARY KEY("local_site_id","policy_id"),
	CONSTRAINT "federation_dataset_use_scope" CHECK (("federation_dataset_use_policies"."local_site_id" <> "federation_dataset_use_policies"."recipient_site_id" AND "federation_dataset_use_policies"."asset"->>'kind' = 'dataset' AND "federation_dataset_use_policies"."asset"->>'originSiteId' = "federation_dataset_use_policies"."local_site_id"::text AND "federation_dataset_use_policies"."expires_at" > "federation_dataset_use_policies"."approved_at") IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_dataset_use_grants" ADD CONSTRAINT "federation_dataset_use_grants_local_site_id_policy_id_federation_dataset_use_policies_local_site_id_policy_id_fk" FOREIGN KEY ("local_site_id","policy_id") REFERENCES "public"."federation_dataset_use_policies"("local_site_id","policy_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_use_policies" ADD CONSTRAINT "federation_dataset_use_policies_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_use_policies" ADD CONSTRAINT "federation_dataset_use_policies_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_use_policies" ADD CONSTRAINT "federation_dataset_use_policies_recipient_site_id_federation_sites_id_fk" FOREIGN KEY ("recipient_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_use_policies" ADD CONSTRAINT "federation_dataset_use_policies_agreement_revision_id_federation_agreements_revision_id_fk" FOREIGN KEY ("agreement_revision_id") REFERENCES "public"."federation_agreements"("revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_use_policies" ADD CONSTRAINT "federation_dataset_use_policies_version_id_data_asset_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_dataset_use_policies" ADD CONSTRAINT "federation_dataset_use_policies_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_dataset_use_org" ON "federation_dataset_use_policies" USING btree ("local_site_id","local_org_id","approved_at");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'asset.read', 'asset.map', 'media.import', 'media.export', 'dataset.use.approve', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));