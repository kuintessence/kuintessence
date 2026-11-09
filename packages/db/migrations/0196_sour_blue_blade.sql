CREATE TABLE "federation_arbitration_decisions" (
	"local_site_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" text NOT NULL,
	"approval_jws" text NOT NULL,
	"basis" jsonb NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_arbitration_decisions_local_site_id_decision_id_pk" PRIMARY KEY("local_site_id","decision_id"),
	CONSTRAINT "federation_arbitration_decision_identity" CHECK (("federation_arbitration_decisions"."payload"->'intent'->>'decisionId' = "federation_arbitration_decisions"."decision_id"::text AND "federation_arbitration_decisions"."payload"->'intent'->'binding'->>'caseId' = "federation_arbitration_decisions"."case_id"::text AND "federation_arbitration_decisions"."payload"->'intent'->'binding'->>'arbitratorSiteId' = "federation_arbitration_decisions"."local_site_id"::text) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_arbitration_decisions" ADD CONSTRAINT "federation_arbitration_decisions_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_decisions" ADD CONSTRAINT "federation_arbitration_decisions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_decisions" ADD CONSTRAINT "federation_arbitration_decision_case_fk" FOREIGN KEY ("local_site_id","case_id") REFERENCES "public"."federation_evidence_cases"("local_site_id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_arbitration_decision_case" ON "federation_arbitration_decisions" USING btree ("local_site_id","case_id");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'payment.approve', 'arbitration.approve', 'arbitration.read', 'arbitration.decide', 'disclosure.approve', 'disclosure.receive', 'case.publish', 'dispute.read', 'dispute.open', 'asset.read', 'asset.map', 'media.import', 'media.export', 'media.logistics', 'dataset.use.approve', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));