CREATE TABLE "federation_commercial_history_recoveries" (
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"recovery_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" text NOT NULL,
	"approval_jws" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"counterparty_jws" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_history_recoveries_local_site_id_recovery_id_pk" PRIMARY KEY("local_site_id","recovery_id"),
	CONSTRAINT "commercial_history_binding" CHECK ((
      "federation_commercial_history_recoveries"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_commercial_history_recoveries"."payload"->>'kind' = 'commercial-history-recovery'
      AND "federation_commercial_history_recoveries"."payload"->>'recoveryId' = "federation_commercial_history_recoveries"."recovery_id"::text
      AND "federation_commercial_history_recoveries"."payload"->>'agreementRevisionId' = "federation_commercial_history_recoveries"."agreement_revision_id"::text
      AND "federation_commercial_history_recoveries"."local_site_id"::text IN ("federation_commercial_history_recoveries"."payload"->>'sourceSiteId', "federation_commercial_history_recoveries"."payload"->>'targetSiteId')
    ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_commercial_submissions" DROP CONSTRAINT "federation_commercial_submission_input";--> statement-breakpoint
ALTER TABLE "federation_dispute_resolutions" DROP CONSTRAINT "dispute_resolution_binding";--> statement-breakpoint
ALTER TABLE "federation_commercial_history_recoveries" ADD CONSTRAINT "federation_commercial_history_recoveries_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_history_recoveries" ADD CONSTRAINT "federation_commercial_history_recoveries_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_history_recoveries" ADD CONSTRAINT "federation_commercial_history_recoveries_submission_id_federation_commercial_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."federation_commercial_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_history_recoveries" ADD CONSTRAINT "federation_commercial_history_recoveries_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_history_recoveries" ADD CONSTRAINT "federation_commercial_history_recoveries_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_history_original" ON "federation_commercial_history_recoveries" USING btree ("local_site_id","submission_id");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'payment.approve', 'arbitration.approve', 'arbitration.read', 'arbitration.decide', 'arbitration.execute', 'disclosure.approve', 'disclosure.receive', 'case.publish', 'dispute.read', 'dispute.open', 'dispute.resolve', 'attestation.recover', 'asset.read', 'asset.map', 'media.import', 'media.export', 'media.logistics', 'dataset.use.approve', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));--> statement-breakpoint
ALTER TABLE "federation_commercial_submissions" ADD CONSTRAINT "federation_commercial_submission_input" CHECK (("federation_commercial_submissions"."input"->>'operation' IN ('register-agreement','record-usage','reserve-execution','release-execution','record-execution-terminal','record-discount','confirm-bill','settle-bill','adjust-settlement','record-refund','record-payment','record-dispute-freeze','record-dispute-resolution','authorize-dispute-resolution','resolve-dispute','record-historical-commercial','freeze-disputed-task','revoke-arbitration-policy','resolve-arbitrated-case','record-arbitration-resolution') AND "federation_commercial_submissions"."input"->>'recordId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'domainId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'digest' ~ '^sha256:[a-f0-9]{64}$') IS TRUE);--> statement-breakpoint
ALTER TABLE "federation_dispute_resolutions" ADD CONSTRAINT "dispute_resolution_binding" CHECK ((
      "federation_dispute_resolutions"."payload"->>'kind' = 'commercial-dispute-resolution'
      AND "federation_dispute_resolutions"."payload"->>'caseId' = "federation_dispute_resolutions"."case_id"::text
      AND "federation_dispute_resolutions"."payload"->>'resolutionId' = "federation_dispute_resolutions"."resolution_id"::text
      AND "federation_dispute_resolutions"."payload"->>'agreementRevisionId' = "federation_dispute_resolutions"."agreement_revision_id"::text
      AND "federation_dispute_resolutions"."payload"->>'mode' IN ('bilateral_direct','bilateral_attested','ledger_coordinated')
      AND ("federation_dispute_resolutions"."payload"->>'protocolVersion' = '1'
        AND "federation_dispute_resolutions"."payload"->>'mode' <> 'ledger_coordinated'
        AND "federation_dispute_resolutions"."payload"->>'decisionId' IS NOT NULL
        AND "federation_dispute_resolutions"."payload"->>'withdrawalDigest' ~ '^sha256:[a-f0-9]{64}$'
        OR "federation_dispute_resolutions"."payload"->>'protocolVersion' = '2'
        AND "federation_dispute_resolutions"."payload"->'decisionId' = 'null'::jsonb
        AND "federation_dispute_resolutions"."payload"->'withdrawalDigest' = 'null'::jsonb
        AND (CASE WHEN "federation_dispute_resolutions"."payload"->>'mode' = 'ledger_coordinated'
          THEN "federation_dispute_resolutions"."payload"->>'freezeDigest' ~ '^sha256:[a-f0-9]{64}$'
          ELSE "federation_dispute_resolutions"."payload"->'freezeDigest' = 'null'::jsonb END))
      AND "federation_dispute_resolutions"."local_site_id"::text IN ("federation_dispute_resolutions"."payload"->>'sourceSiteId', "federation_dispute_resolutions"."payload"->>'targetSiteId')
      AND ("federation_dispute_resolutions"."applied_at" IS NULL OR "federation_dispute_resolutions"."counterparty_jws" IS NOT NULL)
    ) IS TRUE);