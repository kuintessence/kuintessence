CREATE TABLE "federation_closing_tasks" (
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"reference_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"record_id" uuid,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"last_error" varchar(80),
	"completed_at" timestamp with time zone,
	CONSTRAINT "federation_closing_tasks_local_site_id_kind_reference_id_pk" PRIMARY KEY("local_site_id","kind","reference_id"),
	CONSTRAINT "federation_closing_task_kind" CHECK ("federation_closing_tasks"."kind" IN ('bill','settlement')),
	CONSTRAINT "federation_closing_task_state" CHECK ("federation_closing_tasks"."state" IN ('pending','complete','needs_review') AND ("federation_closing_tasks"."state" <> 'complete' OR ("federation_closing_tasks"."record_id" IS NOT NULL AND "federation_closing_tasks"."completed_at" IS NOT NULL))),
	CONSTRAINT "federation_closing_task_lease" CHECK (("federation_closing_tasks"."lease_token" IS NULL) = ("federation_closing_tasks"."lease_until" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "federation_closing_tasks" ADD CONSTRAINT "federation_closing_tasks_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_closing_tasks" ADD CONSTRAINT "federation_closing_tasks_policy_id_federation_closing_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."federation_closing_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_closing_tasks" ADD CONSTRAINT "federation_closing_tasks_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_closing_task_due" ON "federation_closing_tasks" USING btree ("local_site_id","state","next_attempt_at");