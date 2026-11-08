CREATE TABLE "federation_commercial_settlements" (
	"local_site_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"approved_by" uuid NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_settlements_local_site_id_settlement_id_pk" PRIMARY KEY("local_site_id","settlement_id"),
	CONSTRAINT "federation_settlement_identity" CHECK ((
      "federation_commercial_settlements"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_commercial_settlements"."payload"->>'kind' = 'commercial-settlement'
      AND "federation_commercial_settlements"."payload"->>'settlementId' = "federation_commercial_settlements"."settlement_id"::text
      AND "federation_commercial_settlements"."payload"->>'billId' = "federation_commercial_settlements"."bill_id"::text
      AND "federation_commercial_settlements"."payload"->>'agreementRevisionId' = "federation_commercial_settlements"."agreement_revision_id"::text
      AND ("federation_commercial_settlements"."payload"->>'sourceSiteId' = "federation_commercial_settlements"."local_site_id"::text OR "federation_commercial_settlements"."payload"->>'targetSiteId' = "federation_commercial_settlements"."local_site_id"::text)
      AND ("federation_commercial_settlements"."applied_at" IS NULL OR "federation_commercial_settlements"."counterparty_jws" IS NOT NULL)) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_budgets" DROP CONSTRAINT "federation_budget_conservation";--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_commercial_approval_syncs" DROP CONSTRAINT "federation_approval_sync_identity";--> statement-breakpoint
ALTER TABLE "federation_commercial_submissions" DROP CONSTRAINT "federation_commercial_submission_input";--> statement-breakpoint
ALTER TABLE "federation_outbound" DROP CONSTRAINT "federation_outbound_amount";--> statement-breakpoint
ALTER TABLE "federation_reservations" DROP CONSTRAINT "federation_reservation_amount";--> statement-breakpoint
ALTER TABLE "federation_budgets" ADD COLUMN "spent" numeric(38, 0) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "settled_amount" numeric(38, 0);--> statement-breakpoint
ALTER TABLE "federation_reservations" ADD COLUMN "settled_amount" numeric(38, 0);--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" ADD CONSTRAINT "federation_commercial_settlements_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" ADD CONSTRAINT "federation_commercial_settlements_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" ADD CONSTRAINT "federation_commercial_settlements_local_site_id_bill_id_federation_commercial_bills_local_site_id_bill_id_fk" FOREIGN KEY ("local_site_id","bill_id") REFERENCES "public"."federation_commercial_bills"("local_site_id","bill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" ADD CONSTRAINT "federation_commercial_settlements_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_settlement_bill" ON "federation_commercial_settlements" USING btree ("local_site_id","bill_id");--> statement-breakpoint
CREATE INDEX "federation_settlement_org" ON "federation_commercial_settlements" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
ALTER TABLE "federation_budgets" ADD CONSTRAINT "federation_budget_conservation" CHECK ("federation_budgets"."limit"::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND "federation_budgets"."available"::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND "federation_budgets"."reserved"::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND "federation_budgets"."spent"::text ~ '^(0|[1-9][0-9]{0,37})$'
        AND "federation_budgets"."limit" = "federation_budgets"."available" + "federation_budgets"."reserved" + "federation_budgets"."spent");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'asset.read', 'asset.map', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));--> statement-breakpoint
ALTER TABLE "federation_commercial_approval_syncs" ADD CONSTRAINT "federation_approval_sync_identity" CHECK (("federation_commercial_approval_syncs"."record_kind" IN ('agreement','reservation','release','bill','settlement') AND ("federation_commercial_approval_syncs"."record_kind" <> 'agreement' OR "federation_commercial_approval_syncs"."record_id" = "federation_commercial_approval_syncs"."agreement_revision_id")) IS TRUE);--> statement-breakpoint
ALTER TABLE "federation_commercial_submissions" ADD CONSTRAINT "federation_commercial_submission_input" CHECK (("federation_commercial_submissions"."input"->>'operation' IN ('register-agreement','record-usage','reserve-execution','release-execution','record-execution-terminal','record-discount','confirm-bill','settle-bill') AND "federation_commercial_submissions"."input"->>'recordId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'domainId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'digest' ~ '^sha256:[a-f0-9]{64}$') IS TRUE);--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD CONSTRAINT "federation_outbound_amount" CHECK (("federation_outbound"."settled_amount" IS NULL OR ("federation_outbound"."settled_amount" >= 0 AND "federation_outbound"."settled_amount" <= "federation_outbound"."amount")) AND "federation_outbound"."amount"::text ~ '^(0|[1-9][0-9]{0,37})$' AND "federation_outbound"."attempt" > 0);--> statement-breakpoint
ALTER TABLE "federation_reservations" ADD CONSTRAINT "federation_reservation_amount" CHECK (("federation_reservations"."settled_amount" IS NULL OR ("federation_reservations"."settled_amount" >= 0 AND "federation_reservations"."settled_amount" <= "federation_reservations"."amount")) AND "federation_reservations"."amount"::text ~ '^(0|[1-9][0-9]{0,37})$' AND "federation_reservations"."attempt" > 0);