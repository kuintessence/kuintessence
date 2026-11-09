CREATE TABLE "federation_disputes" (
	"local_site_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"opening_jws" text NOT NULL,
	"opened_by" uuid NOT NULL,
	"state" varchar(32) DEFAULT 'FREEZE_PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_disputes_local_site_id_case_id_pk" PRIMARY KEY("local_site_id","case_id"),
	CONSTRAINT "federation_dispute_identity" CHECK ((
      "federation_disputes"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_disputes"."attempt" > 0
      AND "federation_disputes"."payload"->>'kind' = 'commercial-dispute'
      AND "federation_disputes"."payload"->>'caseId' = "federation_disputes"."case_id"::text
      AND "federation_disputes"."payload"->>'agreementRevisionId' = "federation_disputes"."agreement_revision_id"::text
      AND "federation_disputes"."payload"->>'taskId' = "federation_disputes"."task_id"::text
      AND "federation_disputes"."payload"->>'attempt' = "federation_disputes"."attempt"::text
      AND "federation_disputes"."payload"->>'sourceSiteId' <> "federation_disputes"."payload"->>'targetSiteId'
      AND "federation_disputes"."local_site_id"::text IN ("federation_disputes"."payload"->>'sourceSiteId', "federation_disputes"."payload"->>'targetSiteId')
      AND "federation_disputes"."payload"->>'openingSiteId' IN ("federation_disputes"."payload"->>'sourceSiteId', "federation_disputes"."payload"->>'targetSiteId')
    ) IS TRUE),
	CONSTRAINT "federation_dispute_state" CHECK ("federation_disputes"."state" IN ('FREEZE_PENDING','DISPUTED','EVIDENCE_WAITING','DECIDED','APPLICATION_WAITING','RESOLVED'))
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_disputes" ADD CONSTRAINT "federation_disputes_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disputes" ADD CONSTRAINT "federation_disputes_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_disputes" ADD CONSTRAINT "federation_disputes_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_dispute_task" ON "federation_disputes" USING btree ("local_site_id","agreement_revision_id","task_id","attempt");--> statement-breakpoint
CREATE INDEX "federation_dispute_org" ON "federation_disputes" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'payment.approve', 'disclosure.approve', 'dispute.read', 'dispute.open', 'asset.read', 'asset.map', 'media.import', 'media.export', 'media.logistics', 'dataset.use.approve', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));