CREATE TABLE "federation_outbound" (
	"local_site_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"submitted_by" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"budget_domain_id" uuid NOT NULL,
	"epoch" uuid NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"endpoint" text NOT NULL,
	"request" jsonb NOT NULL,
	"request_digest" varchar(71) NOT NULL,
	"request_jws" text NOT NULL,
	"receipt" jsonb,
	"receipt_jws" text,
	"state" varchar(24) DEFAULT 'queued' NOT NULL,
	"last_error" varchar(64),
	"lease_owner" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_outbound_local_site_id_operation_id_pk" PRIMARY KEY("local_site_id","operation_id"),
	CONSTRAINT "federation_outbound_state" CHECK ("federation_outbound"."state" IN ('queued', 'sending', 'accepted', 'needs_review')),
	CONSTRAINT "federation_outbound_amount" CHECK ("federation_outbound"."amount"::text ~ '^(0|[1-9][0-9]{0,37})$' AND "federation_outbound"."attempt" > 0),
	CONSTRAINT "federation_outbound_receipt" CHECK (("federation_outbound"."state" = 'accepted' AND "federation_outbound"."receipt" IS NOT NULL AND "federation_outbound"."receipt_jws" IS NOT NULL) OR ("federation_outbound"."state" <> 'accepted' AND "federation_outbound"."receipt" IS NULL AND "federation_outbound"."receipt_jws" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD CONSTRAINT "federation_outbound_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD CONSTRAINT "federation_outbound_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD CONSTRAINT "federation_outbound_local_site_id_agreement_revision_id_federation_agreement_approvals_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_agreement_approvals"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_outbound_task_attempt" ON "federation_outbound" USING btree ("local_site_id","agreement_revision_id","task_id","attempt");--> statement-breakpoint
CREATE INDEX "federation_outbound_delivery" ON "federation_outbound" USING btree ("local_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "federation_outbound_budget" ON "federation_outbound" USING btree ("local_site_id","budget_domain_id","epoch");--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'asset.read', 'asset.map', 'delegation.read', 'delegation.submit'));