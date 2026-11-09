CREATE TABLE "federation_dispute_freezes" (
	"local_site_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"payload" jsonb,
	"financial_view" jsonb,
	"digest" varchar(71),
	"approval_jws" text,
	"counterparty_jws" text,
	"confirmed_at" timestamp with time zone,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_dispute_freezes_local_site_id_case_id_pk" PRIMARY KEY("local_site_id","case_id"),
	CONSTRAINT "federation_dispute_freeze_state" CHECK ("federation_dispute_freezes"."state" IN ('pending','confirmed','needs_review')),
	CONSTRAINT "federation_dispute_freeze_lease" CHECK (("federation_dispute_freezes"."lease_token" IS NULL) = ("federation_dispute_freezes"."lease_until" IS NULL) AND ("federation_dispute_freezes"."state" = 'pending' OR "federation_dispute_freezes"."lease_token" IS NULL)),
	CONSTRAINT "federation_dispute_freeze_original" CHECK (
    ("federation_dispute_freezes"."payload" IS NULL AND "federation_dispute_freezes"."financial_view" IS NULL AND "federation_dispute_freezes"."digest" IS NULL AND "federation_dispute_freezes"."approval_jws" IS NULL)
    OR ("federation_dispute_freezes"."payload" IS NOT NULL AND "federation_dispute_freezes"."financial_view" IS NOT NULL AND "federation_dispute_freezes"."digest" IS NOT NULL AND "federation_dispute_freezes"."approval_jws" IS NOT NULL
      AND ("federation_dispute_freezes"."digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_dispute_freezes"."payload"->>'kind' = 'commercial-dispute-freeze'
        AND "federation_dispute_freezes"."payload"->>'caseId' = "federation_dispute_freezes"."case_id"::text AND "federation_dispute_freezes"."financial_view"->>'caseId' = "federation_dispute_freezes"."case_id"::text
        AND "federation_dispute_freezes"."payload"->>'caseDigest' = "federation_dispute_freezes"."financial_view"->>'caseDigest'
        AND "federation_dispute_freezes"."payload"->>'headDigest' = "federation_dispute_freezes"."financial_view"->>'headDigest'
        AND "federation_dispute_freezes"."financial_view"->>'localReady' = 'true'
        AND "federation_dispute_freezes"."local_site_id"::text IN ("federation_dispute_freezes"."payload"->>'sourceSiteId', "federation_dispute_freezes"."payload"->>'targetSiteId')) IS TRUE)),
	CONSTRAINT "federation_dispute_freeze_confirmed" CHECK (
    ("federation_dispute_freezes"."state" = 'confirmed') = ("federation_dispute_freezes"."confirmed_at" IS NOT NULL)
    AND ("federation_dispute_freezes"."counterparty_jws" IS NULL) = ("federation_dispute_freezes"."confirmed_at" IS NULL)
    AND ("federation_dispute_freezes"."state" <> 'confirmed' OR ("federation_dispute_freezes"."approval_jws" IS NOT NULL AND "federation_dispute_freezes"."payload"->>'mode' IN ('bilateral_direct','bilateral_attested')) IS TRUE))
);
--> statement-breakpoint
ALTER TABLE "federation_dispute_freezes" ADD CONSTRAINT "federation_dispute_freeze_case_fk" FOREIGN KEY ("local_site_id","case_id") REFERENCES "public"."federation_disputes"("local_site_id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_dispute_freeze_pending" ON "federation_dispute_freezes" USING btree ("local_site_id","state","next_attempt_at");