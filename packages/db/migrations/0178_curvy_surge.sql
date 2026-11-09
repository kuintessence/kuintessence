ALTER TABLE "federation_disputes" ALTER COLUMN "opened_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_disputes" ADD COLUMN "acceptance_jws" text;--> statement-breakpoint
ALTER TABLE "federation_disputes" ADD COLUMN "received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "federation_disputes" ADD CONSTRAINT "federation_dispute_origin" CHECK ((
      ("federation_disputes"."payload"->>'openingSiteId' = "federation_disputes"."local_site_id"::text AND "federation_disputes"."opened_by" IS NOT NULL AND "federation_disputes"."acceptance_jws" IS NULL AND "federation_disputes"."received_at" IS NULL)
      OR ("federation_disputes"."payload"->>'openingSiteId' <> "federation_disputes"."local_site_id"::text AND "federation_disputes"."opened_by" IS NULL AND "federation_disputes"."acceptance_jws" IS NOT NULL AND "federation_disputes"."received_at" IS NOT NULL)
    ) IS TRUE);