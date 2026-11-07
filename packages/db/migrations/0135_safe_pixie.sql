ALTER TABLE "federation_market_submissions" ADD COLUMN "authorization_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "federation_reservation_policies" ADD COLUMN "allow_activation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_reservation_policies" ADD COLUMN "allow_execution_confirmation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD COLUMN "execution_state" varchar(24) DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD COLUMN "execution_error" varchar(64);--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD COLUMN "execution_next_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD COLUMN "execution_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD COLUMN "execution_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD COLUMN "activation_id" uuid;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD COLUMN "confirmation_id" uuid;--> statement-breakpoint
ALTER TABLE "federation_market_submissions" ADD CONSTRAINT "federation_market_submissions_authorization_policy_id_federation_reservation_policies_id_fk" FOREIGN KEY ("authorization_policy_id") REFERENCES "public"."federation_reservation_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD CONSTRAINT "federation_reservation_proposals_activation_id_federation_market_submissions_id_fk" FOREIGN KEY ("activation_id") REFERENCES "public"."federation_market_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD CONSTRAINT "federation_reservation_proposals_confirmation_id_federation_market_submissions_id_fk" FOREIGN KEY ("confirmation_id") REFERENCES "public"."federation_market_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_execution_automation_pending" ON "federation_reservation_proposals" USING btree ("local_site_id","execution_state","execution_next_at");--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD CONSTRAINT "federation_execution_automation_state" CHECK (("federation_reservation_proposals"."execution_state" IN ('idle','pending','complete','needs_review')
      AND (("federation_reservation_proposals"."execution_lease_token" IS NULL) = ("federation_reservation_proposals"."execution_lease_until" IS NULL))) IS TRUE);