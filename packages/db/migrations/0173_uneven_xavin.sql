CREATE TABLE "federation_commercial_payments" (
	"local_site_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"approved_by" uuid NOT NULL,
	"current" boolean DEFAULT false NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_payments_local_site_id_receipt_id_pk" PRIMARY KEY("local_site_id","receipt_id"),
	CONSTRAINT "federation_payment_identity" CHECK ((
      "federation_commercial_payments"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_commercial_payments"."payload"->>'kind' = 'commercial-payment'
      AND "federation_commercial_payments"."payload"->>'receiptId' = "federation_commercial_payments"."receipt_id"::text
      AND "federation_commercial_payments"."payload"->>'paymentId' = "federation_commercial_payments"."payment_id"::text
      AND "federation_commercial_payments"."payload"->>'billId' = "federation_commercial_payments"."bill_id"::text
      AND "federation_commercial_payments"."payload"->>'agreementRevisionId' = "federation_commercial_payments"."agreement_revision_id"::text
      AND ("federation_commercial_payments"."payload"->>'sourceSiteId' = "federation_commercial_payments"."local_site_id"::text OR "federation_commercial_payments"."payload"->>'targetSiteId' = "federation_commercial_payments"."local_site_id"::text)
      AND ("federation_commercial_payments"."counterparty_jws" IS NULL) = ("federation_commercial_payments"."confirmed_at" IS NULL)
      AND (NOT "federation_commercial_payments"."current" OR "federation_commercial_payments"."confirmed_at" IS NOT NULL)
    ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_commercial_payments" ADD CONSTRAINT "federation_commercial_payments_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_payments" ADD CONSTRAINT "federation_commercial_payments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_payments" ADD CONSTRAINT "federation_commercial_payments_local_site_id_bill_id_federation_commercial_bills_local_site_id_bill_id_fk" FOREIGN KEY ("local_site_id","bill_id") REFERENCES "public"."federation_commercial_bills"("local_site_id","bill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_payments" ADD CONSTRAINT "federation_commercial_payments_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_payment_current" ON "federation_commercial_payments" USING btree ("local_site_id","payment_id") WHERE "federation_commercial_payments"."current";--> statement-breakpoint
CREATE UNIQUE INDEX "federation_payment_successor" ON "federation_commercial_payments" USING btree ("local_site_id","payment_id",coalesce("payload"->'previous'->>'receiptId', ''));--> statement-breakpoint
CREATE INDEX "federation_payment_bill" ON "federation_commercial_payments" USING btree ("local_site_id","bill_id","created_at");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'payment.approve', 'asset.read', 'asset.map', 'media.import', 'media.export', 'media.logistics', 'dataset.use.approve', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));