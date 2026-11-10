CREATE TABLE "federation_case_arbitration_decisions" (
	"local_site_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" text NOT NULL,
	"approval_jws" text NOT NULL,
	"submission_jws" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_case_arbitration_decisions_local_site_id_decision_id_pk" PRIMARY KEY("local_site_id","decision_id"),
	CONSTRAINT "federation_case_decision_identity" CHECK (("federation_case_arbitration_decisions"."digest" ~ '^sha256:[a-f0-9]{64}$'
    AND "federation_case_arbitration_decisions"."payload"->>'kind' = 'case-arbitration-decision'
    AND "federation_case_arbitration_decisions"."payload"->>'decisionId' = "federation_case_arbitration_decisions"."decision_id"::text
    AND "federation_case_arbitration_decisions"."payload"->'binding'->>'caseId' = "federation_case_arbitration_decisions"."case_id"::text
    AND "federation_case_arbitration_decisions"."payload"->'binding'->>'arbitratorSiteId' = "federation_case_arbitration_decisions"."local_site_id"::text) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_case_submissions" DROP CONSTRAINT "federation_case_submission_input";--> statement-breakpoint
ALTER TABLE "federation_case_submissions" ALTER COLUMN "publication_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_case_submissions" ADD COLUMN "arbitration_decision_id" uuid;--> statement-breakpoint
ALTER TABLE "federation_case_arbitration_decisions" ADD CONSTRAINT "federation_case_arbitration_decisions_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_arbitration_decisions" ADD CONSTRAINT "federation_case_arbitration_decisions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_arbitration_decisions" ADD CONSTRAINT "federation_case_decision_original_fk" FOREIGN KEY ("local_site_id","decision_id") REFERENCES "public"."federation_arbitration_decisions"("local_site_id","decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_case_decision_case" ON "federation_case_arbitration_decisions" USING btree ("local_site_id","case_id");--> statement-breakpoint
ALTER TABLE "federation_case_submissions" ADD CONSTRAINT "federation_case_submission_decision_fk" FOREIGN KEY ("local_site_id","arbitration_decision_id") REFERENCES "public"."federation_case_arbitration_decisions"("local_site_id","decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_case_submission_decision" ON "federation_case_submissions" USING btree ("local_site_id","arbitration_decision_id");--> statement-breakpoint
ALTER TABLE "federation_case_submissions" ADD CONSTRAINT "federation_case_submission_owner" CHECK ((
      ("federation_case_submissions"."operation" = 'record-arbitration-decision' AND "federation_case_submissions"."arbitration_decision_id" IS NOT NULL AND "federation_case_submissions"."publication_id" IS NULL)
      OR ("federation_case_submissions"."operation" IN ('record-case-evidence','revoke-case-publication') AND "federation_case_submissions"."publication_id" IS NOT NULL AND "federation_case_submissions"."arbitration_decision_id" IS NULL)) IS TRUE);--> statement-breakpoint
ALTER TABLE "federation_case_submissions" ADD CONSTRAINT "federation_case_submission_input" CHECK (("federation_case_submissions"."operation" IN ('record-case-evidence','revoke-case-publication','record-arbitration-decision')
    AND ("federation_case_submissions"."input" IS NULL OR ("federation_case_submissions"."input"->>'operation' = "federation_case_submissions"."operation"
      AND "federation_case_submissions"."input"->>'recordId' IS NOT NULL AND "federation_case_submissions"."input"->>'domainId' IS NOT NULL
      AND "federation_case_submissions"."input"->>'digest' ~ '^sha256:[a-f0-9]{64}$'))
    AND ("federation_case_submissions"."receipt" IS NULL OR ("federation_case_submissions"."input" IS NOT NULL
      AND "federation_case_submissions"."receipt"->>'recordId' = "federation_case_submissions"."input"->>'recordId'
      AND "federation_case_submissions"."receipt"->>'digest' = "federation_case_submissions"."input"->>'digest'))) IS TRUE);