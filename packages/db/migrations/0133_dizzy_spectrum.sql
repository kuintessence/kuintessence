CREATE TABLE "federation_reservation_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_digest" varchar(71) NOT NULL,
	"max_task_amount" numeric(38, 0) NOT NULL,
	"max_total_amount" numeric(38, 0) NOT NULL,
	"max_tasks" integer NOT NULL,
	"authorized_amount" numeric(38, 0) DEFAULT '0' NOT NULL,
	"authorized_tasks" integer DEFAULT 0 NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"granted_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "federation_reservation_policy_valid" CHECK ((
      "federation_reservation_policies"."valid_until" > "federation_reservation_policies"."valid_from" AND "federation_reservation_policies"."agreement_digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_reservation_policies"."max_task_amount" >= 0 AND "federation_reservation_policies"."max_total_amount" >= "federation_reservation_policies"."max_task_amount"
      AND "federation_reservation_policies"."max_tasks" BETWEEN 1 AND 100000
      AND "federation_reservation_policies"."authorized_amount" BETWEEN 0 AND "federation_reservation_policies"."max_total_amount"
      AND "federation_reservation_policies"."authorized_tasks" BETWEEN 0 AND "federation_reservation_policies"."max_tasks"
      AND (("federation_reservation_policies"."revoked_at" IS NULL) = ("federation_reservation_policies"."revoked_by" IS NULL))) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_commercial_execution_approvals" ADD COLUMN "authorization_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "federation_reservation_policies" ADD CONSTRAINT "federation_reservation_policies_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_policies" ADD CONSTRAINT "federation_reservation_policies_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_policies" ADD CONSTRAINT "federation_reservation_policies_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservation_policies" ADD CONSTRAINT "federation_reservation_policies_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_reservation_policy_active" ON "federation_reservation_policies" USING btree ("local_site_id","agreement_revision_id") WHERE "federation_reservation_policies"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "federation_commercial_execution_approvals" ADD CONSTRAINT "federation_commercial_execution_approvals_authorization_policy_id_federation_reservation_policies_id_fk" FOREIGN KEY ("authorization_policy_id") REFERENCES "public"."federation_reservation_policies"("id") ON DELETE no action ON UPDATE no action;