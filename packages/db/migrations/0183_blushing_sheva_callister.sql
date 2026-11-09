CREATE TABLE "federation_disclosures" (
	"local_site_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"recipient_site_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"approved_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_disclosures_local_site_id_grant_id_pk" PRIMARY KEY("local_site_id","grant_id"),
	CONSTRAINT "federation_disclosure_identity" CHECK ((
      "federation_disclosures"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_disclosures"."payload"->>'kind' = 'commercial-disclosure'
      AND "federation_disclosures"."payload"->'grant'->>'grantId' = "federation_disclosures"."grant_id"::text
      AND "federation_disclosures"."payload"->'grant'->>'caseId' = "federation_disclosures"."case_id"::text
      AND "federation_disclosures"."payload"->'grant'->>'policyId' = "federation_disclosures"."policy_id"::text
      AND "federation_disclosures"."payload"->'grant'->>'agreementRevisionId' = "federation_disclosures"."agreement_revision_id"::text
      AND "federation_disclosures"."payload"->'grant'->>'recipientSiteId' = "federation_disclosures"."recipient_site_id"::text
      AND "federation_disclosures"."local_site_id"::text IN ("federation_disclosures"."payload"->'grant'->>'sourceSiteId', "federation_disclosures"."payload"->'grant'->>'targetSiteId')
      AND "federation_disclosures"."payload"->'grant'->>'sourceSiteId' <> "federation_disclosures"."payload"->'grant'->>'targetSiteId'
      AND "federation_disclosures"."recipient_site_id"::text NOT IN ("federation_disclosures"."payload"->'grant'->>'sourceSiteId', "federation_disclosures"."payload"->'grant'->>'targetSiteId')
      AND ("federation_disclosures"."counterparty_jws" IS NULL) = ("federation_disclosures"."confirmed_at" IS NULL)
      AND ("federation_disclosures"."revoked_at" IS NULL) = ("federation_disclosures"."revoked_by" IS NULL)
    ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_disclosures" ADD CONSTRAINT "federation_disclosures_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosures" ADD CONSTRAINT "federation_disclosures_recipient_site_id_federation_sites_id_fk" FOREIGN KEY ("recipient_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosures" ADD CONSTRAINT "federation_disclosures_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosures" ADD CONSTRAINT "federation_disclosures_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosures" ADD CONSTRAINT "federation_disclosures_local_site_id_case_id_federation_disputes_local_site_id_case_id_fk" FOREIGN KEY ("local_site_id","case_id") REFERENCES "public"."federation_disputes"("local_site_id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosures" ADD CONSTRAINT "federation_disclosures_local_site_id_policy_id_federation_disclosure_policies_local_site_id_policy_id_fk" FOREIGN KEY ("local_site_id","policy_id") REFERENCES "public"."federation_disclosure_policies"("local_site_id","policy_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disclosures" ADD CONSTRAINT "federation_disclosures_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_disclosure_case" ON "federation_disclosures" USING btree ("local_site_id","local_org_id","agreement_revision_id","case_id","created_at");