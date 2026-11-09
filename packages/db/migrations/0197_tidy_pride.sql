CREATE TABLE "federation_arbitration_decision_deliveries" (
	"local_site_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"receiving_site_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"receipt_jws" text,
	"acknowledged_at" timestamp with time zone,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arb_decision_delivery_pk" PRIMARY KEY("local_site_id","decision_id","receiving_site_id"),
	CONSTRAINT "federation_arbitration_decision_deliveries_delivery_id_unique" UNIQUE("delivery_id"),
	CONSTRAINT "arb_decision_delivery_state" CHECK ("federation_arbitration_decision_deliveries"."state" IN ('pending','received','needs_review') AND ("federation_arbitration_decision_deliveries"."state" = 'received') = ("federation_arbitration_decision_deliveries"."receipt_jws" IS NOT NULL AND "federation_arbitration_decision_deliveries"."acknowledged_at" IS NOT NULL)),
	CONSTRAINT "arb_decision_delivery_lease" CHECK (("federation_arbitration_decision_deliveries"."lease_token" IS NULL) = ("federation_arbitration_decision_deliveries"."lease_until" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_received_arbitration_decisions" (
	"local_site_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"delivery_jws" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arb_received_decision_pk" PRIMARY KEY("local_site_id","decision_id"),
	CONSTRAINT "arb_received_decision_identity" CHECK (("federation_received_arbitration_decisions"."payload"->>'receivingSiteId' = "federation_received_arbitration_decisions"."local_site_id"::text AND "federation_received_arbitration_decisions"."payload"->>'decisionId' = "federation_received_arbitration_decisions"."decision_id"::text AND "federation_received_arbitration_decisions"."payload"->>'caseId' = "federation_received_arbitration_decisions"."case_id"::text) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_arbitration_decision_deliveries" ADD CONSTRAINT "federation_arbitration_decision_deliveries_receiving_site_id_federation_sites_id_fk" FOREIGN KEY ("receiving_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_arbitration_decision_deliveries" ADD CONSTRAINT "arb_decision_delivery_original_fk" FOREIGN KEY ("local_site_id","decision_id") REFERENCES "public"."federation_arbitration_decisions"("local_site_id","decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_received_arbitration_decisions" ADD CONSTRAINT "federation_received_arbitration_decisions_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_received_arbitration_decisions" ADD CONSTRAINT "arb_received_decision_case_fk" FOREIGN KEY ("local_site_id","case_id") REFERENCES "public"."federation_disputes"("local_site_id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "arb_decision_delivery_pending" ON "federation_arbitration_decision_deliveries" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "arb_received_decision_case" ON "federation_received_arbitration_decisions" USING btree ("local_site_id","case_id");