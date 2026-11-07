CREATE TABLE "federation_agreement_syncs" (
	"local_site_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "federation_agreement_syncs_local_site_id_revision_id_pk" PRIMARY KEY("local_site_id","revision_id"),
	CONSTRAINT "federation_agreement_sync_state" CHECK ("federation_agreement_syncs"."state" IN ('pending','complete','needs_review')),
	CONSTRAINT "federation_agreement_sync_lease" CHECK (("federation_agreement_syncs"."lease_token" IS NULL) = ("federation_agreement_syncs"."lease_until" IS NULL)),
	CONSTRAINT "federation_agreement_sync_receipt" CHECK (("federation_agreement_syncs"."state" = 'complete') = ("federation_agreement_syncs"."verified_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "federation_agreement_syncs" ADD CONSTRAINT "federation_agreement_sync_approval_fk" FOREIGN KEY ("local_site_id","revision_id") REFERENCES "public"."federation_agreement_approvals"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_agreement_sync_pending" ON "federation_agreement_syncs" USING btree ("local_site_id","state","next_attempt_at");