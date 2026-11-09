CREATE TABLE "federation_case_publications" (
	"local_site_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"approved_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revocation_payload" jsonb,
	"revocation_jws" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_case_publications_local_site_id_publication_id_pk" PRIMARY KEY("local_site_id","publication_id"),
	CONSTRAINT "federation_case_publication_identity" CHECK ((
      "federation_case_publications"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_case_publications"."payload"->>'kind' = 'case-evidence-publication'
      AND "federation_case_publications"."payload"->>'publicationId' = "federation_case_publications"."publication_id"::text
      AND "federation_case_publications"."payload"->'scope'->>'agreementRevisionId' = "federation_case_publications"."agreement_revision_id"::text
      AND "federation_case_publications"."payload"->'scope'->>'grantId' = "federation_case_publications"."grant_id"::text
      AND "federation_case_publications"."payload"->'scope'->>'caseId' = "federation_case_publications"."case_id"::text
      AND "federation_case_publications"."local_site_id"::text IN ("federation_case_publications"."payload"->'scope'->>'sourceSiteId', "federation_case_publications"."payload"->'scope'->>'targetSiteId')
      AND ("federation_case_publications"."counterparty_jws" IS NULL) = ("federation_case_publications"."confirmed_at" IS NULL)
      AND ("federation_case_publications"."revoked_at" IS NULL) = ("federation_case_publications"."revoked_by" IS NULL)
      AND ("federation_case_publications"."revoked_at" IS NULL) = ("federation_case_publications"."revocation_payload" IS NULL)
      AND ("federation_case_publications"."revoked_at" IS NULL) = ("federation_case_publications"."revocation_jws" IS NULL)
      AND ("federation_case_publications"."revocation_payload" IS NULL OR (
        "federation_case_publications"."revocation_payload"->>'kind' = 'case-publication-revocation'
        AND "federation_case_publications"."revocation_payload"->>'publicationId' = "federation_case_publications"."publication_id"::text
        AND "federation_case_publications"."revocation_payload"->>'publicationDigest' = "federation_case_publications"."digest"
        AND "federation_case_publications"."revocation_payload"->>'caseDomainId' = "federation_case_publications"."payload"->>'caseDomainId'
        AND "federation_case_publications"."revocation_payload"->>'issuerSiteId' = "federation_case_publications"."local_site_id"::text
      ))
    ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_case_publications" ADD CONSTRAINT "federation_case_publications_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_publications" ADD CONSTRAINT "federation_case_publications_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_publications" ADD CONSTRAINT "federation_case_publications_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_publications" ADD CONSTRAINT "federation_case_publications_local_site_id_grant_id_federation_disclosures_local_site_id_grant_id_fk" FOREIGN KEY ("local_site_id","grant_id") REFERENCES "public"."federation_disclosures"("local_site_id","grant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_publications" ADD CONSTRAINT "federation_case_publications_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_case_publication_org" ON "federation_case_publications" USING btree ("local_site_id","local_org_id","agreement_revision_id","case_id","created_at");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'payment.approve', 'disclosure.approve', 'disclosure.receive', 'case.publish', 'dispute.read', 'dispute.open', 'asset.read', 'asset.map', 'media.import', 'media.export', 'media.logistics', 'dataset.use.approve', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));