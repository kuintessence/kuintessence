CREATE TABLE "federation_market_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"submission_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"transaction_id" varchar(64) NOT NULL,
	"recovery" text NOT NULL,
	"stage" varchar(24) DEFAULT 'proposal' NOT NULL,
	"validation_code" integer,
	"block_number" numeric(20, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_market_attempt" CHECK ("federation_market_attempts"."number" > 0 AND "federation_market_attempts"."transaction_id" ~ '^[a-f0-9]{64}$' AND octet_length("federation_market_attempts"."recovery") BETWEEN 1 AND 4194304),
	CONSTRAINT "federation_market_result" CHECK ((("federation_market_attempts"."stage" IN ('proposal','transaction','abandoned') AND "federation_market_attempts"."validation_code" IS NULL AND "federation_market_attempts"."block_number" IS NULL) OR ("federation_market_attempts"."stage" = 'committed' AND "federation_market_attempts"."validation_code" = 0 AND "federation_market_attempts"."block_number" >= 0) OR ("federation_market_attempts"."stage" = 'invalid' AND "federation_market_attempts"."validation_code" BETWEEN 1 AND 255 AND "federation_market_attempts"."block_number" >= 0)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_market_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"demand_id" uuid NOT NULL,
	"digest" varchar(71) NOT NULL,
	"input" jsonb NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_market_submission_state" CHECK ("federation_market_submissions"."state" IN ('pending','committed','needs_review')),
	CONSTRAINT "federation_market_submission_input" CHECK (("federation_market_submissions"."digest" ~ '^sha256:[a-f0-9]{64}$' AND (
        ("federation_market_submissions"."input"->>'operation' = 'publish-demand' AND "federation_market_submissions"."input"->'demand'->>'demandId' = "federation_market_submissions"."id"::text AND "federation_market_submissions"."input"->'demand'->>'demandId' = "federation_market_submissions"."demand_id"::text AND "federation_market_submissions"."input"->'demand'->>'sourceSiteId' = "federation_market_submissions"."local_site_id"::text)
        OR ("federation_market_submissions"."input"->>'operation' = 'claim-demand' AND "federation_market_submissions"."input"->'claim'->>'claimId' = "federation_market_submissions"."id"::text AND "federation_market_submissions"."input"->'claim'->>'demandId' = "federation_market_submissions"."demand_id"::text AND "federation_market_submissions"."input"->'claim'->>'providerSiteId' = "federation_market_submissions"."local_site_id"::text)
        OR ("federation_market_submissions"."input"->>'operation' = 'cancel-open-demand' AND "federation_market_submissions"."input"->'cancellation'->>'cancellationId' = "federation_market_submissions"."id"::text AND "federation_market_submissions"."input"->'cancellation'->>'demandId' = "federation_market_submissions"."demand_id"::text)
      )) IS TRUE),
	CONSTRAINT "federation_market_submission_lease" CHECK (("federation_market_submissions"."lease_token" IS NULL) = ("federation_market_submissions"."lease_until" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_market_attempts" ADD CONSTRAINT "federation_market_attempts_submission_id_federation_market_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."federation_market_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_market_submissions" ADD CONSTRAINT "federation_market_submissions_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_market_submissions" ADD CONSTRAINT "federation_market_submissions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_market_tx" ON "federation_market_attempts" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_market_attempt_number" ON "federation_market_attempts" USING btree ("submission_id","number");--> statement-breakpoint
CREATE INDEX "federation_market_org" ON "federation_market_submissions" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
CREATE INDEX "federation_market_demand" ON "federation_market_submissions" USING btree ("local_site_id","demand_id");--> statement-breakpoint
CREATE INDEX "federation_market_pending" ON "federation_market_submissions" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'asset.read', 'asset.map', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim'));