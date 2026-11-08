CREATE TABLE "federation_commercial_adjustments" (
	"local_site_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"held_amount" numeric(38, 0) DEFAULT '0' NOT NULL,
	"approved_by" uuid NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_adjustments_local_site_id_adjustment_id_pk" PRIMARY KEY("local_site_id","adjustment_id"),
	CONSTRAINT "federation_adjustment_identity" CHECK ((
      "federation_commercial_adjustments"."number" > 0 AND "federation_commercial_adjustments"."held_amount" >= 0 AND "federation_commercial_adjustments"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_commercial_adjustments"."payload"->>'kind' = 'commercial-adjustment'
      AND "federation_commercial_adjustments"."payload"->>'adjustmentId' = "federation_commercial_adjustments"."adjustment_id"::text
      AND "federation_commercial_adjustments"."payload"->>'settlementId' = "federation_commercial_adjustments"."settlement_id"::text
      AND "federation_commercial_adjustments"."payload"->>'agreementRevisionId' = "federation_commercial_adjustments"."agreement_revision_id"::text
      AND ("federation_commercial_adjustments"."payload"->>'sourceSiteId' = "federation_commercial_adjustments"."local_site_id"::text OR "federation_commercial_adjustments"."payload"->>'targetSiteId' = "federation_commercial_adjustments"."local_site_id"::text)
      AND ("federation_commercial_adjustments"."applied_at" IS NULL OR "federation_commercial_adjustments"."counterparty_jws" IS NOT NULL)
      AND (("federation_commercial_adjustments"."number" = 1) = ("federation_commercial_adjustments"."payload"->'previous' = 'null'::jsonb))
    ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_outbound" DROP CONSTRAINT "federation_outbound_amount";--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "adjustment_held_amount" numeric(38, 0) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_commercial_adjustments" ADD CONSTRAINT "federation_commercial_adjustments_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_adjustments" ADD CONSTRAINT "federation_commercial_adjustments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_adjustments" ADD CONSTRAINT "federation_commercial_adjustments_local_site_id_settlement_id_federation_commercial_settlements_local_site_id_settlement_id_fk" FOREIGN KEY ("local_site_id","settlement_id") REFERENCES "public"."federation_commercial_settlements"("local_site_id","settlement_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_adjustments" ADD CONSTRAINT "federation_commercial_adjustments_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_adjustment_sequence" ON "federation_commercial_adjustments" USING btree ("local_site_id","settlement_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_adjustment_predecessor" ON "federation_commercial_adjustments" USING btree ("local_site_id","settlement_id",coalesce("payload"->'previous'->>'adjustmentId', 'initial'));--> statement-breakpoint
CREATE INDEX "federation_adjustment_org" ON "federation_commercial_adjustments" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'asset.read', 'asset.map', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD CONSTRAINT "federation_outbound_amount" CHECK ("federation_outbound"."adjustment_held_amount" >= 0 AND "federation_outbound"."adjustment_held_amount" <= "federation_outbound"."amount" AND ("federation_outbound"."adjustment_held_amount" = 0 OR "federation_outbound"."settled_amount" IS NOT NULL) AND ("federation_outbound"."settled_amount" IS NULL OR ("federation_outbound"."settled_amount" >= 0 AND "federation_outbound"."settled_amount" + "federation_outbound"."adjustment_held_amount" <= "federation_outbound"."amount")) AND "federation_outbound"."amount"::text ~ '^(0|[1-9][0-9]{0,37})$' AND "federation_outbound"."attempt" > 0);