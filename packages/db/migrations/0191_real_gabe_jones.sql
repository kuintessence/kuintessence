CREATE TABLE "federation_case_revocation_deliveries" (
	"local_site_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
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
	CONSTRAINT "federation_case_revocation_deliveries_local_site_id_publication_id_receiving_site_id_pk" PRIMARY KEY("local_site_id","publication_id","receiving_site_id"),
	CONSTRAINT "federation_case_revocation_delivery_state" CHECK ("federation_case_revocation_deliveries"."local_site_id" <> "federation_case_revocation_deliveries"."receiving_site_id"
    AND "federation_case_revocation_deliveries"."state" IN ('pending','received','needs_review') AND ("federation_case_revocation_deliveries"."state" = 'received') = ("federation_case_revocation_deliveries"."receipt_jws" IS NOT NULL)
    AND ("federation_case_revocation_deliveries"."receipt_jws" IS NULL) = ("federation_case_revocation_deliveries"."acknowledged_at" IS NULL) AND ("federation_case_revocation_deliveries"."payload" IS NULL) = ("federation_case_revocation_deliveries"."notice_jws" IS NULL)
    AND ("federation_case_revocation_deliveries"."lease_token" IS NULL) = ("federation_case_revocation_deliveries"."lease_until" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "federation_case_revocation_notices" (
	"local_site_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"issuer_site_id" uuid NOT NULL,
	"notice_id" uuid NOT NULL,
	"publication_digest" varchar(71) NOT NULL,
	"notice_digest" varchar(71) NOT NULL,
	"revocation_digest" varchar(71) NOT NULL,
	"payload" jsonb NOT NULL,
	"notice_jws" text NOT NULL,
	"receipt_jws" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_case_revocation_notices_local_site_id_publication_id_issuer_site_id_pk" PRIMARY KEY("local_site_id","publication_id","issuer_site_id"),
	CONSTRAINT "federation_case_revocation_notice_identity" CHECK (("federation_case_revocation_notices"."local_site_id" <> "federation_case_revocation_notices"."issuer_site_id"
    AND "federation_case_revocation_notices"."publication_digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_case_revocation_notices"."notice_digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_case_revocation_notices"."revocation_digest" ~ '^sha256:[a-f0-9]{64}$'
    AND "federation_case_revocation_notices"."payload"->>'kind' = 'case-revocation-notice' AND "federation_case_revocation_notices"."payload"->>'noticeId' = "federation_case_revocation_notices"."notice_id"::text
    AND "federation_case_revocation_notices"."payload"->>'issuerSiteId' = "federation_case_revocation_notices"."issuer_site_id"::text AND "federation_case_revocation_notices"."payload"->>'receivingSiteId' = "federation_case_revocation_notices"."local_site_id"::text
    AND "federation_case_revocation_notices"."payload"->'publication'->>'publicationId' = "federation_case_revocation_notices"."publication_id"::text) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_case_revocation_deliveries" ADD CONSTRAINT "federation_case_revocation_delivery_publication_fk" FOREIGN KEY ("local_site_id","publication_id") REFERENCES "public"."federation_case_publications"("local_site_id","publication_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_case_revocation_delivery_pending" ON "federation_case_revocation_deliveries" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_case_revocation_notice_id" ON "federation_case_revocation_notices" USING btree ("local_site_id","notice_id");