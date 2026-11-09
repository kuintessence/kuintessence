CREATE TABLE "federation_dispute_deliveries" (
	"local_site_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"receipt_jws" text,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "federation_dispute_deliveries_local_site_id_case_id_pk" PRIMARY KEY("local_site_id","case_id"),
	CONSTRAINT "federation_dispute_delivery_state" CHECK ("federation_dispute_deliveries"."state" IN ('pending','received','needs_review')),
	CONSTRAINT "federation_dispute_delivery_lease" CHECK (
      ("federation_dispute_deliveries"."lease_token" IS NULL) = ("federation_dispute_deliveries"."lease_until" IS NULL)
      AND ("federation_dispute_deliveries"."state" = 'pending' OR "federation_dispute_deliveries"."lease_token" IS NULL)),
	CONSTRAINT "federation_dispute_delivery_receipt" CHECK (
      ("federation_dispute_deliveries"."state" = 'received') = ("federation_dispute_deliveries"."receipt_jws" IS NOT NULL)
      AND ("federation_dispute_deliveries"."receipt_jws" IS NULL) = ("federation_dispute_deliveries"."acknowledged_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "federation_dispute_deliveries" ADD CONSTRAINT "federation_dispute_delivery_case_fk" FOREIGN KEY ("local_site_id","case_id") REFERENCES "public"."federation_disputes"("local_site_id","case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_dispute_delivery_pending" ON "federation_dispute_deliveries" USING btree ("local_site_id","state","next_attempt_at");