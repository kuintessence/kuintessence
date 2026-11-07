CREATE TABLE "federation_terminal_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_digest" varchar(71) NOT NULL,
	"outcomes" jsonb NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"granted_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "federation_terminal_policy_valid" CHECK (("federation_terminal_policies"."valid_until" > "federation_terminal_policies"."valid_from" AND "federation_terminal_policies"."agreement_digest" ~ '^sha256:[a-f0-9]{64}$' AND jsonb_typeof("federation_terminal_policies"."outcomes") = 'array' AND jsonb_array_length("federation_terminal_policies"."outcomes") BETWEEN 1 AND 3 AND "federation_terminal_policies"."outcomes" <@ '["completed","failed","cancelled"]'::jsonb AND (("federation_terminal_policies"."revoked_at" IS NULL) = ("federation_terminal_policies"."revoked_by" IS NULL))) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_commercial_execution_approvals" ADD COLUMN "terminal_auto_state" varchar(24) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_commercial_execution_approvals" ADD COLUMN "terminal_auto_next_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_commercial_execution_approvals" ADD COLUMN "terminal_auto_error" varchar(64);--> statement-breakpoint
ALTER TABLE "federation_execution_terminals" ADD COLUMN "authorization_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "federation_terminal_policies" ADD CONSTRAINT "federation_terminal_policies_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_terminal_policies" ADD CONSTRAINT "federation_terminal_policies_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_terminal_policies" ADD CONSTRAINT "federation_terminal_policies_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_terminal_policies" ADD CONSTRAINT "federation_terminal_policies_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_terminal_policy_active" ON "federation_terminal_policies" USING btree ("local_site_id","agreement_revision_id") WHERE "federation_terminal_policies"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "federation_execution_terminals" ADD CONSTRAINT "federation_execution_terminals_authorization_policy_id_federation_terminal_policies_id_fk" FOREIGN KEY ("authorization_policy_id") REFERENCES "public"."federation_terminal_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_terminal_auto_pending" ON "federation_commercial_execution_approvals" USING btree ("local_site_id","terminal_auto_state","terminal_auto_next_at");--> statement-breakpoint
ALTER TABLE "federation_commercial_execution_approvals" ADD CONSTRAINT "federation_terminal_auto_state" CHECK ("federation_commercial_execution_approvals"."terminal_auto_state" IN ('pending','needs_review'));