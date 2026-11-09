ALTER TABLE "federation_commercial_submissions" DROP CONSTRAINT "federation_commercial_submission_input";--> statement-breakpoint
ALTER TABLE "federation_dispute_freezes" DROP CONSTRAINT "federation_dispute_freeze_state";--> statement-breakpoint
ALTER TABLE "federation_dispute_freezes" DROP CONSTRAINT "federation_dispute_freeze_lease";--> statement-breakpoint
ALTER TABLE "federation_dispute_freezes" DROP CONSTRAINT "federation_dispute_freeze_confirmed";--> statement-breakpoint
ALTER TABLE "federation_dispute_freezes" ADD COLUMN "ledger_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "federation_commercial_submissions" ADD CONSTRAINT "federation_commercial_submission_input" CHECK (("federation_commercial_submissions"."input"->>'operation' IN ('register-agreement','record-usage','reserve-execution','release-execution','record-execution-terminal','record-discount','confirm-bill','settle-bill','adjust-settlement','record-refund','record-payment','record-dispute-freeze','freeze-disputed-task') AND "federation_commercial_submissions"."input"->>'recordId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'domainId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'digest' ~ '^sha256:[a-f0-9]{64}$') IS TRUE);--> statement-breakpoint
ALTER TABLE "federation_dispute_freezes" ADD CONSTRAINT "federation_dispute_freeze_state" CHECK ("federation_dispute_freezes"."state" IN ('pending','ledger_pending','confirmed','needs_review'));--> statement-breakpoint
ALTER TABLE "federation_dispute_freezes" ADD CONSTRAINT "federation_dispute_freeze_lease" CHECK (("federation_dispute_freezes"."lease_token" IS NULL) = ("federation_dispute_freezes"."lease_until" IS NULL) AND ("federation_dispute_freezes"."state" IN ('pending','ledger_pending') OR "federation_dispute_freezes"."lease_token" IS NULL));--> statement-breakpoint
ALTER TABLE "federation_dispute_freezes" ADD CONSTRAINT "federation_dispute_freeze_confirmed" CHECK (
    ("federation_dispute_freezes"."state" = 'confirmed') = ("federation_dispute_freezes"."confirmed_at" IS NOT NULL)
    AND ("federation_dispute_freezes"."counterparty_jws" IS NULL OR ("federation_dispute_freezes"."approval_jws" IS NOT NULL AND
      ("federation_dispute_freezes"."state" = 'confirmed' OR ("federation_dispute_freezes"."payload"->>'mode' = 'ledger_coordinated' AND "federation_dispute_freezes"."state" IN ('ledger_pending','needs_review')))) IS TRUE)
    AND ("federation_dispute_freezes"."state" NOT IN ('confirmed','ledger_pending') OR "federation_dispute_freezes"."counterparty_jws" IS NOT NULL)
    AND ("federation_dispute_freezes"."state" <> 'ledger_pending' OR ("federation_dispute_freezes"."payload"->>'mode' = 'ledger_coordinated') IS TRUE)
    AND ("federation_dispute_freezes"."ledger_receipt" IS NULL OR ("federation_dispute_freezes"."payload"->>'mode' = 'ledger_coordinated'
      AND "federation_dispute_freezes"."ledger_receipt"->>'recordId' = "federation_dispute_freezes"."case_id"::text AND "federation_dispute_freezes"."ledger_receipt"->>'digest' = "federation_dispute_freezes"."digest"
      AND "federation_dispute_freezes"."state" = 'confirmed') IS TRUE)
    AND ("federation_dispute_freezes"."state" <> 'confirmed' OR ("federation_dispute_freezes"."approval_jws" IS NOT NULL AND
      ("federation_dispute_freezes"."payload"->>'mode' IN ('bilateral_direct','bilateral_attested') OR "federation_dispute_freezes"."ledger_receipt" IS NOT NULL)) IS TRUE));