CREATE TABLE "federation_result_receipts" (
	"local_site_id" uuid NOT NULL,
	"sender_site_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"receipt" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"receipt_jws" text NOT NULL,
	"acknowledgement" jsonb NOT NULL,
	"acknowledgement_jws" text NOT NULL,
	CONSTRAINT "federation_result_receipts_local_site_id_sender_site_id_receipt_id_pk" PRIMARY KEY("local_site_id","sender_site_id","receipt_id")
);
--> statement-breakpoint
ALTER TABLE "federation_result_imports" ADD COLUMN "receipt" jsonb;--> statement-breakpoint
ALTER TABLE "federation_result_imports" ADD COLUMN "receipt_jws" text;--> statement-breakpoint
ALTER TABLE "federation_result_imports" ADD COLUMN "receipt_ack" jsonb;--> statement-breakpoint
ALTER TABLE "federation_result_imports" ADD COLUMN "receipt_ack_jws" text;--> statement-breakpoint
ALTER TABLE "federation_result_imports" ADD COLUMN "receipt_next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_result_imports" ADD COLUMN "receipt_last_error" varchar(64);--> statement-breakpoint
ALTER TABLE "federation_result_receipts" ADD CONSTRAINT "federation_result_receipts_reservation_id_federation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."federation_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_result_receipt_reservation" ON "federation_result_receipts" USING btree ("reservation_id");--> statement-breakpoint
ALTER TABLE "federation_result_imports" ADD CONSTRAINT "federation_result_import_receipt" CHECK (("federation_result_imports"."receipt" IS NULL OR "federation_result_imports"."state" = 'available') AND ("federation_result_imports"."receipt_jws" IS NULL OR "federation_result_imports"."receipt" IS NOT NULL) AND (("federation_result_imports"."receipt_ack" IS NULL AND "federation_result_imports"."receipt_ack_jws" IS NULL) OR ("federation_result_imports"."receipt_ack" IS NOT NULL AND "federation_result_imports"."receipt_ack_jws" IS NOT NULL AND "federation_result_imports"."receipt_jws" IS NOT NULL)));