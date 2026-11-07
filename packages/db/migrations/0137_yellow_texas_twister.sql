CREATE TABLE "federation_market_requests" (
	"local_site_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"demand_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"direction" varchar(16) NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"source_jws" text,
	"source_fingerprint" varchar(64),
	"receipt_jws" text,
	"requested_by" uuid,
	"market_submission_id" uuid,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "federation_market_requests_local_site_id_reservation_id_pk" PRIMARY KEY("local_site_id","reservation_id"),
	CONSTRAINT "federation_market_request_state" CHECK ("federation_market_requests"."state" IN ('pending','complete','needs_review') AND (("federation_market_requests"."state" = 'complete') = ("federation_market_requests"."completed_at" IS NOT NULL))),
	CONSTRAINT "federation_market_request_direction" CHECK ("federation_market_requests"."direction" IN ('outbound','inbound') AND ("federation_market_requests"."direction" <> 'inbound' OR ("federation_market_requests"."source_jws" IS NOT NULL AND "federation_market_requests"."source_fingerprint" IS NOT NULL))),
	CONSTRAINT "federation_market_request_lease" CHECK (("federation_market_requests"."lease_token" IS NULL) = ("federation_market_requests"."lease_until" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "federation_reservation_policies" ADD COLUMN "allow_market_publish" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_reservation_policies" ADD COLUMN "allow_market_claim" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_market_requests" ADD CONSTRAINT "federation_market_requests_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_market_requests" ADD CONSTRAINT "federation_market_requests_policy_id_federation_reservation_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."federation_reservation_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_market_requests" ADD CONSTRAINT "federation_market_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_market_requests" ADD CONSTRAINT "federation_market_requests_market_submission_id_federation_market_submissions_id_fk" FOREIGN KEY ("market_submission_id") REFERENCES "public"."federation_market_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_market_requests" ADD CONSTRAINT "federation_market_request_contract_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_market_request_demand" ON "federation_market_requests" USING btree ("local_site_id","demand_id");--> statement-breakpoint
CREATE INDEX "federation_market_request_pending" ON "federation_market_requests" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "federation_market_request_policy" ON "federation_market_requests" USING btree ("policy_id");