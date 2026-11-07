CREATE TABLE "federation_commercial_agreements" (
	"local_site_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"terms" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"approval_jws" text NOT NULL,
	"counterparty_jws" text,
	"approved_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_agreements_local_site_id_revision_id_pk" PRIMARY KEY("local_site_id","revision_id"),
	CONSTRAINT "federation_commercial_terms" CHECK (("federation_commercial_agreements"."digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_commercial_agreements"."terms"->'agreement'->>'agreementRevisionId' = "federation_commercial_agreements"."revision_id"::text AND ("federation_commercial_agreements"."terms"->'agreement'->>'sourceSiteId' = "federation_commercial_agreements"."local_site_id"::text OR "federation_commercial_agreements"."terms"->'agreement'->>'targetSiteId' = "federation_commercial_agreements"."local_site_id"::text)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_commercial_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"submission_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"transaction_id" varchar(64) NOT NULL,
	"recovery" text NOT NULL,
	"stage" varchar(24) DEFAULT 'proposal' NOT NULL,
	"validation_code" integer,
	"block_number" numeric(20, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_attempt" CHECK ("federation_commercial_attempts"."number" > 0 AND "federation_commercial_attempts"."transaction_id" ~ '^[a-f0-9]{64}$' AND octet_length("federation_commercial_attempts"."recovery") BETWEEN 1 AND 4194304),
	CONSTRAINT "federation_commercial_result" CHECK ((("federation_commercial_attempts"."stage" IN ('proposal','transaction','abandoned') AND "federation_commercial_attempts"."validation_code" IS NULL AND "federation_commercial_attempts"."block_number" IS NULL) OR ("federation_commercial_attempts"."stage" = 'committed' AND "federation_commercial_attempts"."validation_code" = 0 AND "federation_commercial_attempts"."block_number" >= 0) OR ("federation_commercial_attempts"."stage" = 'invalid' AND "federation_commercial_attempts"."validation_code" BETWEEN 1 AND 255 AND "federation_commercial_attempts"."block_number" >= 0)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_commercial_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"local_site_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_commercial_submission_state" CHECK ("federation_commercial_submissions"."state" IN ('pending','committed','needs_review')),
	CONSTRAINT "federation_commercial_submission_input" CHECK (("federation_commercial_submissions"."input"->>'operation' IN ('register-agreement','record-usage') AND "federation_commercial_submissions"."input"->>'recordId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'domainId' IS NOT NULL AND "federation_commercial_submissions"."input"->>'digest' ~ '^sha256:[a-f0-9]{64}$') IS TRUE),
	CONSTRAINT "federation_commercial_submission_lease" CHECK (("federation_commercial_submissions"."lease_token" IS NULL) = ("federation_commercial_submissions"."lease_until" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "federation_commercial_agreements" ADD CONSTRAINT "federation_commercial_agreements_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_agreements" ADD CONSTRAINT "federation_commercial_agreements_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_agreements" ADD CONSTRAINT "federation_commercial_agreements_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_attempts" ADD CONSTRAINT "federation_commercial_attempts_submission_id_federation_commercial_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."federation_commercial_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_commercial_submissions" ADD CONSTRAINT "federation_commercial_submissions_local_site_id_agreement_revision_id_federation_commercial_agreements_local_site_id_revision_id_fk" FOREIGN KEY ("local_site_id","agreement_revision_id") REFERENCES "public"."federation_commercial_agreements"("local_site_id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_commercial_org" ON "federation_commercial_agreements" USING btree ("local_site_id","local_org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_commercial_tx" ON "federation_commercial_attempts" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_commercial_attempt_number" ON "federation_commercial_attempts" USING btree ("submission_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_commercial_record" ON "federation_commercial_submissions" USING btree ("local_site_id",("input"->>'operation'),("input"->>'recordId'));--> statement-breakpoint
CREATE INDEX "federation_commercial_pending" ON "federation_commercial_submissions" USING btree ("local_site_id","state","next_attempt_at");