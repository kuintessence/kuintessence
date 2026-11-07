CREATE TABLE "federation_reservation_proposals" (
	"local_site_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"direction" varchar(16) NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"source_jws" text,
	"source_fingerprint" varchar(64),
	"requested_by" uuid,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"receipt_jws" text,
	"approved_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_reservation_proposals_local_site_id_reservation_id_pk" PRIMARY KEY("local_site_id","reservation_id"),
	CONSTRAINT "federation_reservation_proposal_identity" CHECK ((
      "federation_reservation_proposals"."payload"->>'kind' = 'commercial-reservation' AND "federation_reservation_proposals"."payload"->>'reservationId' = "federation_reservation_proposals"."reservation_id"::text
      AND "federation_reservation_proposals"."payload"->'request'->>'agreementRevisionId' = "federation_reservation_proposals"."agreement_revision_id"::text
      AND "federation_reservation_proposals"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND (("federation_reservation_proposals"."direction" = 'outbound' AND "federation_reservation_proposals"."requested_by" IS NOT NULL AND "federation_reservation_proposals"."source_fingerprint" IS NULL)
        OR ("federation_reservation_proposals"."direction" = 'inbound' AND "federation_reservation_proposals"."requested_by" IS NULL AND "federation_reservation_proposals"."source_fingerprint" ~ '^[a-f0-9]{64}$' AND "federation_reservation_proposals"."source_jws" IS NOT NULL))) IS TRUE),
	CONSTRAINT "federation_reservation_proposal_state" CHECK ((
      "federation_reservation_proposals"."state" IN ('pending','sending','delivered','approved','needs_review')
      AND (("federation_reservation_proposals"."lease_token" IS NULL) = ("federation_reservation_proposals"."lease_until" IS NULL))
      AND ("federation_reservation_proposals"."state" <> 'pending' OR "federation_reservation_proposals"."approved_at" IS NULL)
      AND ("federation_reservation_proposals"."state" NOT IN ('sending','delivered') OR ("federation_reservation_proposals"."direction" = 'outbound' AND "federation_reservation_proposals"."approved_at" IS NOT NULL AND "federation_reservation_proposals"."source_jws" IS NOT NULL))
      AND ("federation_reservation_proposals"."state" <> 'approved' OR ("federation_reservation_proposals"."direction" = 'inbound' AND "federation_reservation_proposals"."approved_at" IS NOT NULL))
      AND (("federation_reservation_proposals"."delivered_at" IS NULL) = ("federation_reservation_proposals"."receipt_jws" IS NULL))
      AND ("federation_reservation_proposals"."state" <> 'delivered' OR "federation_reservation_proposals"."delivered_at" IS NOT NULL)) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD CONSTRAINT "federation_reservation_proposals_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD CONSTRAINT "federation_reservation_proposals_policy_id_federation_reservation_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."federation_reservation_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD CONSTRAINT "federation_reservation_proposals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_proposals" ADD CONSTRAINT "federation_reservation_proposals_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_reservation_proposal_pending" ON "federation_reservation_proposals" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "federation_reservation_proposal_org" ON "federation_reservation_proposals" USING btree ("local_site_id","local_org_id","agreement_revision_id");