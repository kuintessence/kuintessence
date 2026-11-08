CREATE TABLE "federation_media_receipts" (
	"local_site_id" uuid NOT NULL,
	"sender_site_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"receipt" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"receipt_jws" text NOT NULL,
	"acknowledgement" jsonb NOT NULL,
	"acknowledgement_jws" text NOT NULL,
	CONSTRAINT "federation_media_receipts_local_site_id_sender_site_id_receipt_id_pk" PRIMARY KEY("local_site_id","sender_site_id","receipt_id"),
	CONSTRAINT "federation_media_receipt_scope" CHECK (("federation_media_receipts"."local_site_id" <> "federation_media_receipts"."sender_site_id" AND "federation_media_receipts"."digest" ~ '^sha256:[a-f0-9]{64}$' AND
    "federation_media_receipts"."receipt"->>'receiptId' = "federation_media_receipts"."receipt_id"::text AND "federation_media_receipts"."receipt"->>'packageId' = "federation_media_receipts"."package_id"::text AND
    "federation_media_receipts"."receipt"->>'senderSiteId' = "federation_media_receipts"."sender_site_id"::text AND "federation_media_receipts"."receipt"->>'recipientSiteId' = "federation_media_receipts"."local_site_id"::text AND
    "federation_media_receipts"."acknowledgement"->>'receiptDigest' = "federation_media_receipts"."digest") IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_media_import_operations" ADD COLUMN "receipt" jsonb;--> statement-breakpoint
ALTER TABLE "federation_media_import_operations" ADD COLUMN "receipt_jws" text;--> statement-breakpoint
ALTER TABLE "federation_media_import_operations" ADD COLUMN "receipt_ack" jsonb;--> statement-breakpoint
ALTER TABLE "federation_media_import_operations" ADD COLUMN "receipt_ack_jws" text;--> statement-breakpoint
ALTER TABLE "federation_media_import_operations" ADD COLUMN "receipt_token" uuid;--> statement-breakpoint
ALTER TABLE "federation_media_import_operations" ADD COLUMN "receipt_next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_media_import_operations" ADD COLUMN "receipt_last_error" varchar(32);--> statement-breakpoint
ALTER TABLE "federation_media_receipts" ADD CONSTRAINT "federation_media_receipts_sender_site_id_federation_sites_id_fk" FOREIGN KEY ("sender_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_media_receipts" ADD CONSTRAINT "federation_media_receipts_local_site_id_package_id_federation_media_exports_local_site_id_package_id_fk" FOREIGN KEY ("local_site_id","package_id") REFERENCES "public"."federation_media_exports"("local_site_id","package_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_media_receipt_package" ON "federation_media_receipts" USING btree ("local_site_id","package_id");--> statement-breakpoint
CREATE INDEX "federation_media_import_receipt_pending" ON "federation_media_import_operations" USING btree ("receipt_next_attempt_at");