ALTER TABLE "software_operations" ADD COLUMN "idempotency_key" varchar(255);--> statement-breakpoint
ALTER TABLE "software_operations" ADD COLUMN "idempotency_item_index" integer;--> statement-breakpoint
ALTER TABLE "software_operations" ADD COLUMN "idempotency_item_count" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "software_operations_request_idempotency_idx" ON "software_operations" USING btree ("requested_by","idempotency_key","idempotency_item_index");