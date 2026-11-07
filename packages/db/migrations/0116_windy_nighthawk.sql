CREATE TABLE "federation_usage_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reservation_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"report" jsonb NOT NULL,
	"report_jws" text NOT NULL,
	"digest" varchar(71) NOT NULL,
	"evidence_set" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_usage_report_identity" CHECK (coalesce("federation_usage_reports"."number" > 0 AND "federation_usage_reports"."report"->>'reportId' = "federation_usage_reports"."id"::text
    AND "federation_usage_reports"."evidence_set"->>'reservationId' = "federation_usage_reports"."reservation_id"::text AND "federation_usage_reports"."digest" ~ '^sha256:[a-f0-9]{64}$',false))
);
--> statement-breakpoint
CREATE TABLE "federation_usage_tasks" (
	"reservation_id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" varchar(64),
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_usage_task_state" CHECK ("federation_usage_tasks"."state" IN ('pending','missing_data','needs_review','reported'))
);
--> statement-breakpoint
ALTER TABLE "federation_usage_reports" ADD CONSTRAINT "federation_usage_reports_reservation_id_federation_usage_tasks_reservation_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."federation_usage_tasks"("reservation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_usage_tasks" ADD CONSTRAINT "federation_usage_tasks_reservation_id_federation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."federation_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_usage_tasks" ADD CONSTRAINT "federation_usage_tasks_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_usage_tasks" ADD CONSTRAINT "federation_usage_tasks_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_usage_report_sequence" ON "federation_usage_reports" USING btree ("reservation_id","number");--> statement-breakpoint
CREATE INDEX "federation_usage_pending" ON "federation_usage_tasks" USING btree ("local_site_id","state","next_attempt_at");