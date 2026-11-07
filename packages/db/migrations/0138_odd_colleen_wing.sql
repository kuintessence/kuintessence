CREATE TABLE "federation_commercial_bills" (
	"local_site_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"approved_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_bills_local_site_id_bill_id_pk" PRIMARY KEY("local_site_id","bill_id"),
	CONSTRAINT "federation_bill_identity" CHECK (("federation_commercial_bills"."digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_commercial_bills"."attempt" > 0
    AND "federation_commercial_bills"."payload"->>'kind' = 'commercial-bill' AND "federation_commercial_bills"."payload"->>'billId' = "federation_commercial_bills"."bill_id"::text
    AND "federation_commercial_bills"."payload"->'request'->>'agreementRevisionId' = "federation_commercial_bills"."agreement_revision_id"::text
    AND "federation_commercial_bills"."payload"->'request'->>'taskId' = "federation_commercial_bills"."task_id"::text AND "federation_commercial_bills"."payload"->'request'->>'attempt' = "federation_commercial_bills"."attempt"::text
    AND ("federation_commercial_bills"."payload"->'request'->>'senderSiteId' = "federation_commercial_bills"."local_site_id"::text OR "federation_commercial_bills"."payload"->'request'->>'recipientSiteId' = "federation_commercial_bills"."local_site_id"::text)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_commercial_discounts" (
	"local_site_id" uuid NOT NULL,
	"discount_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"provider_jws" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_discounts_local_site_id_discount_id_pk" PRIMARY KEY("local_site_id","discount_id"),
	CONSTRAINT "federation_discount_identity" CHECK (("federation_commercial_discounts"."digest" ~ '^sha256:[a-f0-9]{64}$'
    AND "federation_commercial_discounts"."payload"->>'kind' = 'commercial-discount' AND "federation_commercial_discounts"."payload"->>'discountId' = "federation_commercial_discounts"."discount_id"::text
    AND "federation_commercial_discounts"."payload"->>'agreementRevisionId' = "federation_commercial_discounts"."agreement_revision_id"::text
    AND ("federation_commercial_discounts"."payload"->>'sourceSiteId' = "federation_commercial_discounts"."local_site_id"::text OR "federation_commercial_discounts"."payload"->>'targetSiteId' = "federation_commercial_discounts"."local_site_id"::text)) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_commercial_submissions" DROP CONSTRAINT "federation_commercial_submission_input";--> statement-breakpoint
ALTER TABLE "federation_commercial_bills" ADD CONSTRAINT "federation_commercial_bills_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_bills" ADD CONSTRAINT "federation_commercial_bills_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_bills" ADD CONSTRAINT "federation_commercial_bills_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_discounts" ADD CONSTRAINT "federation_commercial_discounts_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_discounts" ADD CONSTRAINT "federation_commercial_discounts_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_discounts" ADD CONSTRAINT "federation_commercial_discounts_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_bill_task_attempt" ON "federation_commercial_bills" USING btree ("local_site_id","agreement_revision_id","task_id","attempt");--> statement-breakpoint
CREATE INDEX "federation_bill_org" ON "federation_commercial_bills" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
CREATE INDEX "federation_discount_org" ON "federation_commercial_discounts" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'asset.read', 'asset.map', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));--> statement-breakpoint
ALTER TABLE "federation_commercial_submissions" ADD CONSTRAINT "federation_commercial_submission_input" CHECK (("federation_commercial_submissions"."input"->>'operation' IN ('register-agreement','record-usage','reserve-execution','release-execution','record-execution-terminal','record-discount','confirm-bill') AND "federation_commercial_submissions"."input"->>'recordId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'domainId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'digest' ~ '^sha256:[a-f0-9]{64}$') IS TRUE);