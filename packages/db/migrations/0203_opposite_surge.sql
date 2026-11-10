CREATE TABLE "federation_dispute_resolutions" (
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"resolution_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" text NOT NULL,
	"approval_jws" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"counterparty_jws" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_dispute_resolutions_local_site_id_case_id_pk" PRIMARY KEY("local_site_id","case_id"),
	CONSTRAINT "dispute_resolution_binding" CHECK ((
      "federation_dispute_resolutions"."payload"->>'kind' = 'commercial-dispute-resolution'
      AND "federation_dispute_resolutions"."payload"->>'caseId' = "federation_dispute_resolutions"."case_id"::text
      AND "federation_dispute_resolutions"."payload"->>'resolutionId' = "federation_dispute_resolutions"."resolution_id"::text
      AND "federation_dispute_resolutions"."payload"->>'agreementRevisionId' = "federation_dispute_resolutions"."agreement_revision_id"::text
      AND "federation_dispute_resolutions"."payload"->>'mode' IN ('bilateral_direct','bilateral_attested')
      AND "federation_dispute_resolutions"."local_site_id"::text IN ("federation_dispute_resolutions"."payload"->>'sourceSiteId', "federation_dispute_resolutions"."payload"->>'targetSiteId')
      AND ("federation_dispute_resolutions"."applied_at" IS NULL OR "federation_dispute_resolutions"."counterparty_jws" IS NOT NULL)
    ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_commercial_approval_syncs" DROP CONSTRAINT "federation_approval_sync_identity";--> statement-breakpoint
ALTER TABLE "federation_commercial_submissions" DROP CONSTRAINT "federation_commercial_submission_input";--> statement-breakpoint
ALTER TABLE "federation_dispute_resolutions" ADD CONSTRAINT "dispute_resolution_case_fk" FOREIGN KEY ("local_site_id","case_id") REFERENCES "public"."federation_disputes"("local_site_id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_resolution_identity" ON "federation_dispute_resolutions" USING btree ("local_site_id","resolution_id");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'payment.approve', 'arbitration.approve', 'arbitration.read', 'arbitration.decide', 'arbitration.execute', 'disclosure.approve', 'disclosure.receive', 'case.publish', 'dispute.read', 'dispute.open', 'dispute.resolve', 'asset.read', 'asset.map', 'media.import', 'media.export', 'media.logistics', 'dataset.use.approve', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));--> statement-breakpoint
ALTER TABLE "federation_commercial_approval_syncs" ADD CONSTRAINT "federation_approval_sync_identity" CHECK (("federation_commercial_approval_syncs"."record_kind" IN ('agreement','reservation','release','bill','settlement','adjustment','refund','payment','arbitration-policy','disclosure-policy','disclosure','case-publication','dispute-resolution') AND ("federation_commercial_approval_syncs"."record_kind" <> 'agreement' OR "federation_commercial_approval_syncs"."record_id" = "federation_commercial_approval_syncs"."agreement_revision_id")) IS TRUE);--> statement-breakpoint
ALTER TABLE "federation_commercial_submissions" ADD CONSTRAINT "federation_commercial_submission_input" CHECK (("federation_commercial_submissions"."input"->>'operation' IN ('register-agreement','record-usage','reserve-execution','release-execution','record-execution-terminal','record-discount','confirm-bill','settle-bill','adjust-settlement','record-refund','record-payment','record-dispute-freeze','record-dispute-resolution','freeze-disputed-task','revoke-arbitration-policy','resolve-arbitrated-case','record-arbitration-resolution') AND "federation_commercial_submissions"."input"->>'recordId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'domainId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'digest' ~ '^sha256:[a-f0-9]{64}$') IS TRUE);