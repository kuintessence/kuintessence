ALTER TABLE "federation_arbitration_resolutions" ADD COLUMN "withdrawal_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "federation_received_arbitration_decisions" ADD COLUMN "execution_withdrawal" jsonb;--> statement-breakpoint
ALTER TABLE "federation_received_arbitration_decisions" ADD COLUMN "execution_withdrawal_jws" text;--> statement-breakpoint
ALTER TABLE "federation_arbitration_resolutions" ADD CONSTRAINT "arb_resolution_withdrawal_request" CHECK (("federation_arbitration_resolutions"."withdrawal_requested_at" IS NULL OR (
        "federation_arbitration_resolutions"."commitment" IS NOT NULL AND "federation_arbitration_resolutions"."payload"->>'mode' IN ('bilateral_direct','bilateral_attested')
        AND "federation_arbitration_resolutions"."payload"->'outcome'->>'action' IN ('settle','adjust')
      )) IS TRUE);--> statement-breakpoint
ALTER TABLE "federation_received_arbitration_decisions" ADD CONSTRAINT "arb_received_execution_withdrawal" CHECK ((("federation_received_arbitration_decisions"."execution_withdrawal" IS NULL) = ("federation_received_arbitration_decisions"."execution_withdrawal_jws" IS NULL)
      AND ("federation_received_arbitration_decisions"."execution_withdrawal" IS NULL OR (
        "federation_received_arbitration_decisions"."execution_withdrawal"->>'kind' = 'arbitration-execution-withdrawal-receipt'
        AND "federation_received_arbitration_decisions"."execution_withdrawal"->'resolution'->>'decisionId' = "federation_received_arbitration_decisions"."decision_id"::text
        AND "federation_received_arbitration_decisions"."execution_withdrawal"->'resolution'->>'caseId' = "federation_received_arbitration_decisions"."case_id"::text
        AND "federation_received_arbitration_decisions"."execution_withdrawal"->'resolution'->>'decisionDigest' = "federation_received_arbitration_decisions"."payload"->>'decisionDigest'
        AND "federation_received_arbitration_decisions"."execution_withdrawal"->'resolution'->>'mode' IN ('bilateral_direct','bilateral_attested')
      ))) IS TRUE);