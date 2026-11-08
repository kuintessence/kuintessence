CREATE TABLE "federation_closing_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"agreement_digest" varchar(71) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"outcomes" jsonb NOT NULL,
	"max_amount" numeric(38, 0) NOT NULL,
	"max_total_amount" numeric(38, 0) NOT NULL,
	"max_records" integer NOT NULL,
	"approved_amount" numeric(38, 0) DEFAULT '0' NOT NULL,
	"approved_records" integer DEFAULT 0 NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"granted_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "federation_closing_policy_kind" CHECK ("federation_closing_policies"."kind" IN ('bill','settlement')),
	CONSTRAINT "federation_closing_policy_limits" CHECK ("federation_closing_policies"."max_amount" >= 0 AND "federation_closing_policies"."max_total_amount" >= "federation_closing_policies"."max_amount" AND "federation_closing_policies"."max_records" BETWEEN 1 AND 100000 AND "federation_closing_policies"."approved_amount" BETWEEN 0 AND "federation_closing_policies"."max_total_amount" AND "federation_closing_policies"."approved_records" BETWEEN 0 AND "federation_closing_policies"."max_records"),
	CONSTRAINT "federation_closing_policy_time" CHECK ("federation_closing_policies"."valid_until" > "federation_closing_policies"."valid_from" AND ("federation_closing_policies"."revoked_at" IS NULL) = ("federation_closing_policies"."revoked_by" IS NULL)),
	CONSTRAINT "federation_closing_policy_outcomes" CHECK (jsonb_typeof("federation_closing_policies"."outcomes") = 'array' AND jsonb_array_length("federation_closing_policies"."outcomes") BETWEEN 1 AND 3 AND "federation_closing_policies"."outcomes" <@ '["completed","failed","cancelled"]'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "federation_commercial_bills" ADD COLUMN "authorization_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" ADD COLUMN "authorization_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "federation_closing_policies" ADD CONSTRAINT "federation_closing_policies_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_closing_policies" ADD CONSTRAINT "federation_closing_policies_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_closing_policies" ADD CONSTRAINT "federation_closing_policies_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_closing_policies" ADD CONSTRAINT "federation_closing_policies_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_closing_policy_active" ON "federation_closing_policies" USING btree ("local_site_id","agreement_revision_id","kind") WHERE "federation_closing_policies"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "federation_commercial_bills" ADD CONSTRAINT "federation_commercial_bills_authorization_policy_id_federation_closing_policies_id_fk" FOREIGN KEY ("authorization_policy_id") REFERENCES "public"."federation_closing_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_settlements" ADD CONSTRAINT "federation_commercial_settlements_authorization_policy_id_federation_closing_policies_id_fk" FOREIGN KEY ("authorization_policy_id") REFERENCES "public"."federation_closing_policies"("id") ON DELETE no action ON UPDATE no action;