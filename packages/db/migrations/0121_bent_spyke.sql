CREATE TABLE "federation_commercial_execution_approvals" (
	"local_site_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"approved_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_execution_approvals_local_site_id_record_id_pk" PRIMARY KEY("local_site_id","record_id"),
	CONSTRAINT "federation_execution_approval_payload" CHECK ((
      "federation_commercial_execution_approvals"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND (("federation_commercial_execution_approvals"."payload"->>'kind' = 'commercial-reservation'
        AND "federation_commercial_execution_approvals"."payload"->>'reservationId' = "federation_commercial_execution_approvals"."record_id"::text
        AND "federation_commercial_execution_approvals"."payload"->'request'->>'agreementRevisionId' = "federation_commercial_execution_approvals"."agreement_revision_id"::text)
      OR ("federation_commercial_execution_approvals"."payload"->>'kind' = 'commercial-release'
        AND "federation_commercial_execution_approvals"."payload"->>'releaseId' = "federation_commercial_execution_approvals"."record_id"::text))
    ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_commercial_submissions" DROP CONSTRAINT "federation_commercial_submission_input";--> statement-breakpoint
ALTER TABLE "federation_commercial_execution_approvals" ADD CONSTRAINT "federation_commercial_execution_approvals_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_execution_approvals" ADD CONSTRAINT "federation_commercial_execution_approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_execution_approvals" ADD CONSTRAINT "federation_commercial_execution_approvals_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_execution_approval_org" ON "federation_commercial_execution_approvals" USING btree ("local_site_id","local_org_id","agreement_revision_id","created_at");--> statement-breakpoint
ALTER TABLE "federation_commercial_submissions" ADD CONSTRAINT "federation_commercial_submission_input" CHECK (("federation_commercial_submissions"."input"->>'operation' IN ('register-agreement','record-usage','reserve-execution','release-execution') AND "federation_commercial_submissions"."input"->>'recordId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'domainId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'digest' ~ '^sha256:[a-f0-9]{64}$') IS TRUE);