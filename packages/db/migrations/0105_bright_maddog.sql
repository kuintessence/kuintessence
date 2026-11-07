ALTER TABLE "federation_outbound" ADD COLUMN "status_report" jsonb;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "status_report_jws" text;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "status_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "status_last_error" varchar(64);--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "status_claim" uuid;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "status_next_attempt_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
CREATE INDEX "federation_outbound_status" ON "federation_outbound" USING btree ("local_site_id","status_next_attempt_at","operation_id") WHERE "federation_outbound"."state" = 'accepted' AND "federation_outbound"."status_next_attempt_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD CONSTRAINT "federation_outbound_status_report" CHECK (("federation_outbound"."status_report" IS NULL AND "federation_outbound"."status_report_jws" IS NULL AND "federation_outbound"."status_verified_at" IS NULL)
        OR ("federation_outbound"."status_report" IS NOT NULL AND "federation_outbound"."status_report_jws" IS NOT NULL AND "federation_outbound"."status_verified_at" IS NOT NULL AND "federation_outbound"."state" = 'accepted'));