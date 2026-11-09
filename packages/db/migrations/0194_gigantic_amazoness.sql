CREATE TABLE "federation_arbitration_revocation_deliveries" (
	"local_site_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"receiving_site_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"payload" jsonb,
	"notice_jws" text,
	"receipt_jws" text,
	"acknowledged_at" timestamp with time zone,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arb_revocation_delivery_pk" PRIMARY KEY("local_site_id","policy_id","receiving_site_id"),
	CONSTRAINT "arb_revocation_delivery_state" CHECK ("federation_arbitration_revocation_deliveries"."local_site_id" <> "federation_arbitration_revocation_deliveries"."receiving_site_id"
    AND "federation_arbitration_revocation_deliveries"."state" IN ('pending','received','needs_review') AND ("federation_arbitration_revocation_deliveries"."state" = 'received') = ("federation_arbitration_revocation_deliveries"."receipt_jws" IS NOT NULL)
    AND ("federation_arbitration_revocation_deliveries"."receipt_jws" IS NULL) = ("federation_arbitration_revocation_deliveries"."acknowledged_at" IS NULL) AND ("federation_arbitration_revocation_deliveries"."payload" IS NULL) = ("federation_arbitration_revocation_deliveries"."notice_jws" IS NULL)
    AND ("federation_arbitration_revocation_deliveries"."lease_token" IS NULL) = ("federation_arbitration_revocation_deliveries"."lease_until" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_arbitration_revocation_notices" (
	"local_site_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_digest" varchar(71) NOT NULL,
	"issuer_site_id" uuid NOT NULL,
	"notice_id" uuid NOT NULL,
	"notice_digest" varchar(71) NOT NULL,
	"revocation_digest" varchar(71) NOT NULL,
	"payload" jsonb NOT NULL,
	"notice_jws" text NOT NULL,
	"receipt_jws" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arb_revocation_notice_pk" PRIMARY KEY("local_site_id","policy_id","policy_digest","issuer_site_id"),
	CONSTRAINT "arb_revocation_notice_identity" CHECK (("federation_arbitration_revocation_notices"."local_site_id" <> "federation_arbitration_revocation_notices"."issuer_site_id"
    AND "federation_arbitration_revocation_notices"."policy_digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_arbitration_revocation_notices"."notice_digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_arbitration_revocation_notices"."revocation_digest" ~ '^sha256:[a-f0-9]{64}$'
    AND "federation_arbitration_revocation_notices"."payload"->>'kind' = 'arbitration-revocation-notice' AND "federation_arbitration_revocation_notices"."payload"->>'noticeId' = "federation_arbitration_revocation_notices"."notice_id"::text
    AND "federation_arbitration_revocation_notices"."payload"->>'issuerSiteId' = "federation_arbitration_revocation_notices"."issuer_site_id"::text AND "federation_arbitration_revocation_notices"."payload"->>'receivingSiteId' = "federation_arbitration_revocation_notices"."local_site_id"::text
    AND "federation_arbitration_revocation_notices"."payload"->'policy'->>'policyId' = "federation_arbitration_revocation_notices"."policy_id"::text) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_arbitration_policies" DROP CONSTRAINT "federation_arbitration_policy_identity";--> statement-breakpoint
ALTER TABLE "federation_arbitration_policies" ADD COLUMN "revocation_payload" jsonb;--> statement-breakpoint
ALTER TABLE "federation_arbitration_policies" ADD COLUMN "revocation_jws" text;--> statement-breakpoint
ALTER TABLE "federation_arbitration_revocation_deliveries" ADD CONSTRAINT "arb_revocation_delivery_policy_fk" FOREIGN KEY ("local_site_id","policy_id") REFERENCES "public"."federation_arbitration_policies"("local_site_id","policy_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "arb_revocation_delivery_pending" ON "federation_arbitration_revocation_deliveries" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "arb_revocation_notice_id" ON "federation_arbitration_revocation_notices" USING btree ("local_site_id","notice_id");--> statement-breakpoint
ALTER TABLE "federation_arbitration_policies" ADD CONSTRAINT "federation_arbitration_policy_identity" CHECK ((
      "federation_arbitration_policies"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_arbitration_policies"."payload"->>'kind' = 'commercial-arbitration-policy'
      AND "federation_arbitration_policies"."payload"->>'policyId' = "federation_arbitration_policies"."policy_id"::text
      AND "federation_arbitration_policies"."payload"->>'agreementRevisionId' = "federation_arbitration_policies"."agreement_revision_id"::text
      AND "federation_arbitration_policies"."payload"->>'arbitratorSiteId' = "federation_arbitration_policies"."arbitrator_site_id"::text
      AND ("federation_arbitration_policies"."payload"->>'sourceSiteId' = "federation_arbitration_policies"."local_site_id"::text OR "federation_arbitration_policies"."payload"->>'targetSiteId' = "federation_arbitration_policies"."local_site_id"::text)
      AND "federation_arbitration_policies"."payload"->>'sourceSiteId' <> "federation_arbitration_policies"."payload"->>'targetSiteId'
      AND "federation_arbitration_policies"."arbitrator_site_id"::text NOT IN ("federation_arbitration_policies"."payload"->>'sourceSiteId', "federation_arbitration_policies"."payload"->>'targetSiteId')
      AND ("federation_arbitration_policies"."counterparty_jws" IS NULL) = ("federation_arbitration_policies"."confirmed_at" IS NULL)
      AND ("federation_arbitration_policies"."revoked_at" IS NULL) = ("federation_arbitration_policies"."revoked_by" IS NULL)
      AND ("federation_arbitration_policies"."revocation_payload" IS NULL) = ("federation_arbitration_policies"."revocation_jws" IS NULL)
      AND ("federation_arbitration_policies"."revocation_payload" IS NULL OR ("federation_arbitration_policies"."revoked_at" IS NOT NULL
        AND "federation_arbitration_policies"."revocation_payload"->>'policyId' = "federation_arbitration_policies"."policy_id"::text
        AND "federation_arbitration_policies"."revocation_payload"->>'policyDigest' = "federation_arbitration_policies"."digest"
        AND "federation_arbitration_policies"."revocation_payload"->>'issuerSiteId' = "federation_arbitration_policies"."local_site_id"::text))
    ) IS TRUE);