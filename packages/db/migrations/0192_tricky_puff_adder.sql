CREATE TABLE "federation_arbitration_policies" (
	"local_site_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"arbitrator_site_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"approved_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_arbitration_policies_local_site_id_policy_id_pk" PRIMARY KEY("local_site_id","policy_id"),
	CONSTRAINT "federation_arbitration_policy_identity" CHECK ((
      "federation_arbitration_policies"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_arbitration_policies"."payload"->>'kind' = 'commercial-arbitration-policy'
      AND "federation_arbitration_policies"."payload"->>'policyId' = "federation_arbitration_policies"."policy_id"::text
      AND "federation_arbitration_policies"."payload"->>'agreementRevisionId' = "federation_arbitration_policies"."agreement_revision_id"::text
      AND "federation_arbitration_policies"."payload"->>'arbitratorSiteId' = "federation_arbitration_policies"."arbitrator_site_id"::text
      AND ("federation_arbitration_policies"."payload"->>'sourceSiteId' = "federation_arbitration_policies"."local_site_id"::text OR "federation_arbitration_policies"."payload"->>'targetSiteId' = "federation_arbitration_policies"."local_site_id"::text)
      AND "federation_arbitration_policies"."payload"->>'sourceSiteId' <> "federation_arbitration_policies"."payload"->>'targetSiteId'
      AND "federation_arbitration_policies"."arbitrator_site_id"::text NOT IN ("federation_arbitration_policies"."payload"->>'sourceSiteId', "federation_arbitration_policies"."payload"->>'targetSiteId')
      AND ("federation_arbitration_policies"."counterparty_jws" IS NULL) = ("federation_arbitration_policies"."confirmed_at" IS NULL)
      AND ("federation_arbitration_policies"."revoked_at" IS NULL) = ("federation_arbitration_policies"."revoked_by" IS NULL)
    ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_commercial_approval_syncs" DROP CONSTRAINT "federation_approval_sync_identity";--> statement-breakpoint
ALTER TABLE "federation_arbitration_policies" ADD CONSTRAINT "federation_arbitration_policies_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_policies" ADD CONSTRAINT "federation_arbitration_policies_arbitrator_site_id_federation_sites_id_fk" FOREIGN KEY ("arbitrator_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_policies" ADD CONSTRAINT "federation_arbitration_policies_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_policies" ADD CONSTRAINT "federation_arbitration_policies_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_policies" ADD CONSTRAINT "federation_arbitration_policies_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_arbitration_policy_org" ON "federation_arbitration_policies" USING btree ("local_site_id","local_org_id","agreement_revision_id","created_at");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'payment.approve', 'arbitration.approve', 'disclosure.approve', 'disclosure.receive', 'case.publish', 'dispute.read', 'dispute.open', 'asset.read', 'asset.map', 'media.import', 'media.export', 'media.logistics', 'dataset.use.approve', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));--> statement-breakpoint
ALTER TABLE "federation_commercial_approval_syncs" ADD CONSTRAINT "federation_approval_sync_identity" CHECK (("federation_commercial_approval_syncs"."record_kind" IN ('agreement','reservation','release','bill','settlement','adjustment','refund','payment','arbitration-policy','disclosure-policy','disclosure','case-publication') AND ("federation_commercial_approval_syncs"."record_kind" <> 'agreement' OR "federation_commercial_approval_syncs"."record_id" = "federation_commercial_approval_syncs"."agreement_revision_id")) IS TRUE);