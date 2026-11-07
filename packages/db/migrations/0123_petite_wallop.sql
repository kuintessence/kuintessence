ALTER TABLE "federation_agreements" ALTER COLUMN "budget_domain_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_agreements" ALTER COLUMN "epoch" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_agreements" ADD CONSTRAINT "federation_agreement_budget_backing" CHECK (((("federation_agreements"."terms"->>'mode' IN ('bilateral_direct', 'bilateral_attested'))
        AND "federation_agreements"."budget_domain_id" IS NOT NULL AND "federation_agreements"."epoch" IS NOT NULL
        AND "federation_agreements"."budget_domain_id" = ("federation_agreements"."terms"->>'budgetDomainId')::uuid
        AND "federation_agreements"."epoch" = ("federation_agreements"."terms"->>'epoch')::uuid)
        OR ("federation_agreements"."terms"->>'mode' = 'ledger_coordinated'
        AND "federation_agreements"."budget_domain_id" IS NULL AND "federation_agreements"."epoch" IS NULL)) IS TRUE);