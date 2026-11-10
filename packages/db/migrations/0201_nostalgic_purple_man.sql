ALTER TABLE "federation_arbitration_resolutions" DROP CONSTRAINT "arb_resolution_identity";--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD COLUMN "commitment" jsonb;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD COLUMN "commitment_jws" text;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD COLUMN "counterparty_commitment" jsonb;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD COLUMN "counterparty_commitment_jws" text;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD COLUMN "execution_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD COLUMN "execution_receipt_jws" text;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD COLUMN "held_amount" numeric(38, 0) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD CONSTRAINT "arb_resolution_commitment" CHECK ((
      ("federation_arbitration_resolutions"."commitment" IS NULL) = ("federation_arbitration_resolutions"."commitment_jws" IS NULL)
      AND ("federation_arbitration_resolutions"."counterparty_commitment" IS NULL) = ("federation_arbitration_resolutions"."counterparty_commitment_jws" IS NULL)
      AND ("federation_arbitration_resolutions"."execution_receipt" IS NULL) = ("federation_arbitration_resolutions"."execution_receipt_jws" IS NULL)
      AND "federation_arbitration_resolutions"."held_amount" >= 0
      AND (("federation_arbitration_resolutions"."payload"->>'mode' = 'ledger_coordinated' OR "federation_arbitration_resolutions"."payload"->'outcome'->>'action' = 'resolve-without-financial-change')
        OR ("federation_arbitration_resolutions"."commitment" IS NOT NULL AND ("federation_arbitration_resolutions"."applied_at" IS NULL OR "federation_arbitration_resolutions"."execution_receipt" IS NOT NULL)))
    ) IS TRUE);--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD CONSTRAINT "arb_resolution_identity" CHECK (("federation_arbitration_resolutions"."payload"->>'decisionId' = "federation_arbitration_resolutions"."decision_id"::text AND "federation_arbitration_resolutions"."payload"->>'caseId' = "federation_arbitration_resolutions"."case_id"::text
    AND "federation_arbitration_resolutions"."payload"->>'agreementRevisionId' = "federation_arbitration_resolutions"."agreement_revision_id"::text
    AND ("federation_arbitration_resolutions"."payload"->>'sourceSiteId' = "federation_arbitration_resolutions"."local_site_id"::text OR "federation_arbitration_resolutions"."payload"->>'targetSiteId' = "federation_arbitration_resolutions"."local_site_id"::text)
    AND ("federation_arbitration_resolutions"."payload"->'outcome'->>'action' = 'resolve-without-financial-change'
      OR "federation_arbitration_resolutions"."payload"->'outcome'->>'action' IN ('settle', 'adjust'))) IS TRUE);