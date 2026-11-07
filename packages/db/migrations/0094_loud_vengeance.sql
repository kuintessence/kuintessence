CREATE TABLE "federation_cancellations" (
	"local_site_id" uuid NOT NULL,
	"sender_site_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"request_digest" varchar(71) NOT NULL,
	"cancellation_digest" varchar(71) NOT NULL,
	"request" jsonb NOT NULL,
	"request_jws" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "federation_cancellations_local_site_id_sender_site_id_operation_id_pk" PRIMARY KEY("local_site_id","sender_site_id","operation_id")
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "cancel_request" jsonb;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "cancel_jws" text;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "cancel_digest" varchar(71);--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "cancel_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "cancel_state" varchar(24);--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "cancel_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "cancel_receipt_jws" text;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "cancel_last_error" varchar(64);--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "cancel_lease_owner" uuid;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "cancel_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "cancel_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "federation_cancellations" ADD CONSTRAINT "federation_cancellations_agreement_revision_id_federation_agreements_revision_id_fk" FOREIGN KEY ("agreement_revision_id") REFERENCES "public"."federation_agreements"("revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD CONSTRAINT "federation_outbound_cancel_requested_by_users_id_fk" FOREIGN KEY ("cancel_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_outbound_cancel" ON "federation_outbound" USING btree ("local_site_id","cancel_state","cancel_next_attempt_at");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'asset.read', 'asset.map', 'delegation.read', 'delegation.submit', 'delegation.cancel'));--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD CONSTRAINT "federation_outbound_cancel_intent" CHECK (
      ("federation_outbound"."cancel_state" IS NULL AND "federation_outbound"."cancel_request" IS NULL AND "federation_outbound"."cancel_jws" IS NULL AND "federation_outbound"."cancel_digest" IS NULL AND "federation_outbound"."cancel_requested_by" IS NULL)
      OR ("federation_outbound"."cancel_state" IS NOT NULL AND "federation_outbound"."cancel_state" IN ('queued','sending','pending','stopped','needs_review') AND "federation_outbound"."cancel_request" IS NOT NULL AND "federation_outbound"."cancel_jws" IS NOT NULL AND "federation_outbound"."cancel_digest" IS NOT NULL AND "federation_outbound"."cancel_requested_by" IS NOT NULL AND "federation_outbound"."cancel_next_attempt_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD CONSTRAINT "federation_outbound_cancel_stopped" CHECK ("federation_outbound"."cancel_state" IS DISTINCT FROM 'stopped' OR ("federation_outbound"."cancel_receipt" IS NOT NULL AND "federation_outbound"."cancel_receipt_jws" IS NOT NULL AND coalesce("federation_outbound"."cancel_receipt"->>'state' = 'stopped', false)));