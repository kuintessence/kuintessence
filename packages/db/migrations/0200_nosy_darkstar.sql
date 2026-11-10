ALTER TABLE "federation_arbitration_resolutions" DROP CONSTRAINT "arb_resolution_identity";--> statement-breakpoint
ALTER TABLE "federation_commercial_adjustments" DROP CONSTRAINT "federation_adjustment_identity";--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" DROP CONSTRAINT "federation_settlement_identity";--> statement-breakpoint
ALTER TABLE "federation_commercial_adjustments" ALTER COLUMN "approval_jws" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" ALTER COLUMN "approval_jws" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_commercial_adjustments" ADD COLUMN "arbitration_decision_id" uuid;--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" ADD COLUMN "arbitration_decision_id" uuid;--> statement-breakpoint
ALTER TABLE "federation_commercial_adjustments" ADD CONSTRAINT "federation_commercial_adjustments_local_site_id_arbitration_decision_id_federation_arbitration_resolutions_local_site_id_decision_id_fk" FOREIGN KEY ("local_site_id","arbitration_decision_id") REFERENCES "public"."federation_arbitration_resolutions"("local_site_id","decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" ADD CONSTRAINT "federation_commercial_settlements_local_site_id_arbitration_decision_id_federation_arbitration_resolutions_local_site_id_decision_id_fk" FOREIGN KEY ("local_site_id","arbitration_decision_id") REFERENCES "public"."federation_arbitration_resolutions"("local_site_id","decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD CONSTRAINT "arb_resolution_identity" CHECK (("federation_arbitration_resolutions"."payload"->>'decisionId' = "federation_arbitration_resolutions"."decision_id"::text AND "federation_arbitration_resolutions"."payload"->>'caseId' = "federation_arbitration_resolutions"."case_id"::text
    AND "federation_arbitration_resolutions"."payload"->>'agreementRevisionId' = "federation_arbitration_resolutions"."agreement_revision_id"::text
    AND ("federation_arbitration_resolutions"."payload"->>'sourceSiteId' = "federation_arbitration_resolutions"."local_site_id"::text OR "federation_arbitration_resolutions"."payload"->>'targetSiteId' = "federation_arbitration_resolutions"."local_site_id"::text)
    AND ("federation_arbitration_resolutions"."payload"->'outcome'->>'action' = 'resolve-without-financial-change'
      OR ("federation_arbitration_resolutions"."payload"->>'mode' = 'ledger_coordinated' AND "federation_arbitration_resolutions"."payload"->'outcome'->>'action' IN ('settle', 'adjust')))) IS TRUE);--> statement-breakpoint
ALTER TABLE "federation_commercial_adjustments" ADD CONSTRAINT "federation_adjustment_identity" CHECK ((
      "federation_commercial_adjustments"."number" > 0 AND "federation_commercial_adjustments"."held_amount" >= 0 AND "federation_commercial_adjustments"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_commercial_adjustments"."payload"->>'kind' = 'commercial-adjustment'
      AND "federation_commercial_adjustments"."payload"->>'adjustmentId' = "federation_commercial_adjustments"."adjustment_id"::text
      AND "federation_commercial_adjustments"."payload"->>'settlementId' = "federation_commercial_adjustments"."settlement_id"::text
      AND "federation_commercial_adjustments"."payload"->>'agreementRevisionId' = "federation_commercial_adjustments"."agreement_revision_id"::text
      AND ("federation_commercial_adjustments"."payload"->>'sourceSiteId' = "federation_commercial_adjustments"."local_site_id"::text OR "federation_commercial_adjustments"."payload"->>'targetSiteId' = "federation_commercial_adjustments"."local_site_id"::text)
      AND (( "federation_commercial_adjustments"."arbitration_decision_id" IS NULL AND "federation_commercial_adjustments"."approval_jws" IS NOT NULL)
        OR ("federation_commercial_adjustments"."arbitration_decision_id" IS NOT NULL AND "federation_commercial_adjustments"."approval_jws" IS NULL AND "federation_commercial_adjustments"."counterparty_jws" IS NULL))
      AND ("federation_commercial_adjustments"."applied_at" IS NULL OR "federation_commercial_adjustments"."counterparty_jws" IS NOT NULL OR "federation_commercial_adjustments"."arbitration_decision_id" IS NOT NULL)
      AND (("federation_commercial_adjustments"."number" = 1) = ("federation_commercial_adjustments"."payload"->'previous' = 'null'::jsonb))
    ) IS TRUE);--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" ADD CONSTRAINT "federation_settlement_identity" CHECK ((
      "federation_commercial_settlements"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_commercial_settlements"."payload"->>'kind' = 'commercial-settlement'
      AND "federation_commercial_settlements"."payload"->>'settlementId' = "federation_commercial_settlements"."settlement_id"::text
      AND "federation_commercial_settlements"."payload"->>'billId' = "federation_commercial_settlements"."bill_id"::text
      AND "federation_commercial_settlements"."payload"->>'agreementRevisionId' = "federation_commercial_settlements"."agreement_revision_id"::text
      AND ("federation_commercial_settlements"."payload"->>'sourceSiteId' = "federation_commercial_settlements"."local_site_id"::text OR "federation_commercial_settlements"."payload"->>'targetSiteId' = "federation_commercial_settlements"."local_site_id"::text)
      AND (( "federation_commercial_settlements"."arbitration_decision_id" IS NULL AND "federation_commercial_settlements"."approval_jws" IS NOT NULL)
        OR ("federation_commercial_settlements"."arbitration_decision_id" IS NOT NULL AND "federation_commercial_settlements"."approval_jws" IS NULL AND "federation_commercial_settlements"."counterparty_jws" IS NULL))
      AND ("federation_commercial_settlements"."applied_at" IS NULL OR "federation_commercial_settlements"."counterparty_jws" IS NOT NULL OR "federation_commercial_settlements"."arbitration_decision_id" IS NOT NULL)) IS TRUE);