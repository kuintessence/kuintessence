ALTER TABLE "file_transfers" ADD COLUMN "dispatch_owner" uuid;--> statement-breakpoint
ALTER TABLE "file_transfers" ADD COLUMN "dispatch_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "file_transfers" ADD COLUMN "cancel_request" uuid;--> statement-breakpoint
CREATE INDEX "file_transfers_owner_lease_idx" ON "file_transfers" USING btree ("dispatch_owner","dispatch_expires_at") WHERE dispatch_owner is not null;--> statement-breakpoint
CREATE INDEX "file_transfers_pending_cancel_idx" ON "file_transfers" USING btree ("dispatch_owner") WHERE cancel_request is not null;