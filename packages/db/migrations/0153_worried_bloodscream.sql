CREATE TABLE "federation_commercial_refunds" (
	"local_site_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"approved_by" uuid NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_refunds_local_site_id_refund_id_pk" PRIMARY KEY("local_site_id","refund_id"),
	CONSTRAINT "federation_refund_identity" CHECK ((
    "federation_commercial_refunds"."digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_commercial_refunds"."payload"->>'kind' = 'commercial-refund'
    AND "federation_commercial_refunds"."payload"->>'refundId' = "federation_commercial_refunds"."refund_id"::text
    AND "federation_commercial_refunds"."payload"->'request'->>'agreementRevisionId' = "federation_commercial_refunds"."agreement_revision_id"::text
    AND "federation_commercial_refunds"."payload"->'request'->>'operationId' = "federation_commercial_refunds"."operation_id"::text
    AND "federation_commercial_refunds"."payload"->'request'->>'mode' IN ('bilateral_direct','bilateral_attested')
    AND "federation_commercial_refunds"."payload"->>'releasedAmount' = "federation_commercial_refunds"."payload"->'request'->>'maxAmount'
    AND ("federation_commercial_refunds"."payload"->'request'->>'senderSiteId' = "federation_commercial_refunds"."local_site_id"::text OR "federation_commercial_refunds"."payload"->'request'->>'recipientSiteId' = "federation_commercial_refunds"."local_site_id"::text)
    AND ("federation_commercial_refunds"."applied_at" IS NULL OR "federation_commercial_refunds"."counterparty_jws" IS NOT NULL)) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_commercial_refunds" ADD CONSTRAINT "federation_commercial_refunds_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_refunds" ADD CONSTRAINT "federation_commercial_refunds_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_refunds" ADD CONSTRAINT "federation_commercial_refunds_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_refund_operation" ON "federation_commercial_refunds" USING btree ("local_site_id","operation_id");--> statement-breakpoint
CREATE INDEX "federation_refund_org" ON "federation_commercial_refunds" USING btree ("local_site_id","local_org_id","created_at");