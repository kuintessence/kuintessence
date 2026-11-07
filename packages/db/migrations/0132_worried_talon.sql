CREATE TABLE "federation_commercial_approval_syncs" (
	"local_site_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"record_kind" varchar(16) NOT NULL,
	"record_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "federation_commercial_approval_syncs_local_site_id_record_kind_record_id_pk" PRIMARY KEY("local_site_id","record_kind","record_id"),
	CONSTRAINT "federation_approval_sync_identity" CHECK (("federation_commercial_approval_syncs"."record_kind" IN ('agreement','reservation','release') AND ("federation_commercial_approval_syncs"."record_kind" <> 'agreement' OR "federation_commercial_approval_syncs"."record_id" = "federation_commercial_approval_syncs"."agreement_revision_id")) IS TRUE),
	CONSTRAINT "federation_approval_sync_state" CHECK ("federation_commercial_approval_syncs"."state" IN ('pending','complete','needs_review')),
	CONSTRAINT "federation_approval_sync_lease" CHECK (("federation_commercial_approval_syncs"."lease_token" IS NULL) = ("federation_commercial_approval_syncs"."lease_until" IS NULL)),
	CONSTRAINT "federation_approval_sync_receipt" CHECK (("federation_commercial_approval_syncs"."state" = 'complete') = ("federation_commercial_approval_syncs"."verified_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "federation_commercial_approval_syncs" ADD CONSTRAINT "federation_approval_sync_contract_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_approval_sync_pending" ON "federation_commercial_approval_syncs" USING btree ("local_site_id","state","next_attempt_at");