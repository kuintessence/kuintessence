CREATE TABLE "federation_arbitration_resolutions" (
	"local_site_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"envelope" jsonb NOT NULL,
	"initiated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "arb_resolution_pk" PRIMARY KEY("local_site_id","decision_id"),
	CONSTRAINT "arb_resolution_identity" CHECK (("federation_arbitration_resolutions"."payload"->>'decisionId' = "federation_arbitration_resolutions"."decision_id"::text AND "federation_arbitration_resolutions"."payload"->>'caseId' = "federation_arbitration_resolutions"."case_id"::text
    AND "federation_arbitration_resolutions"."payload"->>'agreementRevisionId' = "federation_arbitration_resolutions"."agreement_revision_id"::text
    AND ("federation_arbitration_resolutions"."payload"->>'sourceSiteId' = "federation_arbitration_resolutions"."local_site_id"::text OR "federation_arbitration_resolutions"."payload"->>'targetSiteId' = "federation_arbitration_resolutions"."local_site_id"::text)
    AND "federation_arbitration_resolutions"."payload"->'outcome'->>'action' = 'resolve-without-financial-change') IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_commercial_submissions" DROP CONSTRAINT "federation_commercial_submission_input";--> statement-breakpoint
ALTER TABLE "federation_commercial_attempts" ADD COLUMN "dispatch_authorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD CONSTRAINT "federation_arbitration_resolutions_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD CONSTRAINT "federation_arbitration_resolutions_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD CONSTRAINT "arb_resolution_received_fk" FOREIGN KEY ("local_site_id","decision_id") REFERENCES "public"."federation_received_arbitration_decisions"("local_site_id","decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "arb_resolution_case" ON "federation_arbitration_resolutions" USING btree ("local_site_id","case_id");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'payment.approve', 'arbitration.approve', 'arbitration.read', 'arbitration.decide', 'arbitration.execute', 'disclosure.approve', 'disclosure.receive', 'case.publish', 'dispute.read', 'dispute.open', 'asset.read', 'asset.map', 'media.import', 'media.export', 'media.logistics', 'dataset.use.approve', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));--> statement-breakpoint
ALTER TABLE "federation_commercial_submissions" ADD CONSTRAINT "federation_commercial_submission_input" CHECK (("federation_commercial_submissions"."input"->>'operation' IN ('register-agreement','record-usage','reserve-execution','release-execution','record-execution-terminal','record-discount','confirm-bill','settle-bill','adjust-settlement','record-refund','record-payment','record-dispute-freeze','freeze-disputed-task','revoke-arbitration-policy','resolve-arbitrated-case','record-arbitration-resolution') AND "federation_commercial_submissions"."input"->>'recordId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'domainId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'digest' ~ '^sha256:[a-f0-9]{64}$') IS TRUE);