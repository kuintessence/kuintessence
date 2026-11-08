CREATE TABLE "federation_unreserved_closures" (
	"local_site_id" uuid NOT NULL,
	"demand_id" uuid NOT NULL,
	"origin_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_unreserved_closures_local_site_id_demand_id_pk" PRIMARY KEY("local_site_id","demand_id"),
	CONSTRAINT "federation_unreserved_closure_identity" CHECK ((
      "federation_unreserved_closures"."digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_unreserved_closures"."payload"->>'status' = 'CLOSED'
      AND "federation_unreserved_closures"."payload"->'demand'->>'demandId' = "federation_unreserved_closures"."demand_id"::text
      AND "federation_unreserved_closures"."payload"->'unreservedClosure'->>'demandId' = "federation_unreserved_closures"."demand_id"::text
      AND "federation_unreserved_closures"."payload"->'unreservedClosure'->>'claimId' = "federation_unreserved_closures"."payload"->'claim'->>'claimId'
      AND ("federation_unreserved_closures"."payload"->'demand'->>'sourceSiteId' = "federation_unreserved_closures"."local_site_id"::text
        OR "federation_unreserved_closures"."payload"->'claim'->>'providerSiteId' = "federation_unreserved_closures"."local_site_id"::text)
    ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_commercial_approval_syncs" DROP CONSTRAINT "federation_approval_sync_state";--> statement-breakpoint
ALTER TABLE "federation_market_requests" DROP CONSTRAINT "federation_market_request_state";--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" DROP CONSTRAINT "federation_execution_automation_state";--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" DROP CONSTRAINT "federation_reservation_proposal_state";--> statement-breakpoint
ALTER TABLE "federation_market_submissions" ADD COLUMN "closure_check_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_unreserved_closures" ADD CONSTRAINT "federation_unreserved_closures_origin_id_federation_market_submissions_id_fk" FOREIGN KEY ("origin_id") REFERENCES "public"."federation_market_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_market_closure_check" ON "federation_market_submissions" USING btree ("local_site_id","closure_check_at") WHERE "federation_market_submissions"."state" = 'committed' AND "federation_market_submissions"."input"->>'operation' IN ('publish-demand','claim-demand');--> statement-breakpoint
ALTER TABLE "federation_commercial_approval_syncs" ADD CONSTRAINT "federation_approval_sync_state" CHECK ("federation_commercial_approval_syncs"."state" IN ('pending','complete','needs_review','closed'));--> statement-breakpoint
ALTER TABLE "federation_market_requests" ADD CONSTRAINT "federation_market_request_state" CHECK ("federation_market_requests"."state" IN ('pending','complete','needs_review','closed') AND (("federation_market_requests"."state" = 'complete') = ("federation_market_requests"."completed_at" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD CONSTRAINT "federation_execution_automation_state" CHECK (("federation_reservation_proposals"."execution_state" IN ('idle','pending','complete','needs_review','closed')
      AND (("federation_reservation_proposals"."execution_lease_token" IS NULL) = ("federation_reservation_proposals"."execution_lease_until" IS NULL))) IS TRUE);--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD CONSTRAINT "federation_reservation_proposal_state" CHECK ((
      "federation_reservation_proposals"."state" IN ('pending','sending','delivered','approved','needs_review','closed')
      AND (("federation_reservation_proposals"."lease_token" IS NULL) = ("federation_reservation_proposals"."lease_until" IS NULL))
      AND ("federation_reservation_proposals"."state" <> 'pending' OR "federation_reservation_proposals"."approved_at" IS NULL)
      AND ("federation_reservation_proposals"."state" NOT IN ('sending','delivered') OR ("federation_reservation_proposals"."direction" = 'outbound' AND "federation_reservation_proposals"."approved_at" IS NOT NULL AND "federation_reservation_proposals"."source_jws" IS NOT NULL))
      AND ("federation_reservation_proposals"."state" <> 'approved' OR ("federation_reservation_proposals"."direction" = 'inbound' AND "federation_reservation_proposals"."approved_at" IS NOT NULL))
      AND (("federation_reservation_proposals"."delivered_at" IS NULL) = ("federation_reservation_proposals"."receipt_jws" IS NULL))
      AND ("federation_reservation_proposals"."state" <> 'delivered' OR "federation_reservation_proposals"."delivered_at" IS NOT NULL)) IS TRUE);