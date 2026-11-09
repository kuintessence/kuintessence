CREATE TABLE "federation_case_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"transaction_id" varchar(64) NOT NULL,
	"recovery" text NOT NULL,
	"stage" varchar(24) DEFAULT 'proposal' NOT NULL,
	"dispatch_authorized_at" timestamp with time zone,
	"validation_code" integer,
	"block_number" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_case_attempt_state" CHECK (("federation_case_attempts"."number" > 0 AND "federation_case_attempts"."transaction_id" ~ '^[a-f0-9]{64}$'
    AND "federation_case_attempts"."stage" IN ('proposal','transaction','committed','invalid','abandoned')
    AND ("federation_case_attempts"."dispatch_authorized_at" IS NULL OR "federation_case_attempts"."stage" IN ('transaction','committed','invalid'))
    AND (("federation_case_attempts"."stage" IN ('committed','invalid')) = ("federation_case_attempts"."validation_code" IS NOT NULL))
    AND (("federation_case_attempts"."stage" IN ('committed','invalid')) = ("federation_case_attempts"."block_number" IS NOT NULL))
    AND ("federation_case_attempts"."stage" <> 'committed' OR "federation_case_attempts"."validation_code" = 0)
    AND ("federation_case_attempts"."stage" <> 'invalid' OR "federation_case_attempts"."validation_code" BETWEEN 1 AND 255)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_case_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_site_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"operation" varchar(32) NOT NULL,
	"input" jsonb,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"receipt" jsonb,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_case_submission_state" CHECK ("federation_case_submissions"."state" IN ('pending','committed','needs_review','closed')
    AND ("federation_case_submissions"."state" = 'committed') = ("federation_case_submissions"."receipt" IS NOT NULL)
    AND ("federation_case_submissions"."lease_token" IS NULL) = ("federation_case_submissions"."lease_until" IS NULL)),
	CONSTRAINT "federation_case_submission_input" CHECK (("federation_case_submissions"."operation" IN ('record-case-evidence','revoke-case-publication')
    AND ("federation_case_submissions"."input" IS NULL OR ("federation_case_submissions"."input"->>'operation' = "federation_case_submissions"."operation"
      AND "federation_case_submissions"."input"->>'recordId' IS NOT NULL AND "federation_case_submissions"."input"->>'domainId' IS NOT NULL
      AND "federation_case_submissions"."input"->>'digest' ~ '^sha256:[a-f0-9]{64}$'))
    AND ("federation_case_submissions"."receipt" IS NULL OR ("federation_case_submissions"."input" IS NOT NULL
      AND "federation_case_submissions"."receipt"->>'recordId' = "federation_case_submissions"."input"->>'recordId'
      AND "federation_case_submissions"."receipt"->>'digest' = "federation_case_submissions"."input"->>'digest'))) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_case_attempts" ADD CONSTRAINT "federation_case_attempts_submission_id_federation_case_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."federation_case_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_case_submissions" ADD CONSTRAINT "federation_case_submission_publication_fk" FOREIGN KEY ("local_site_id","publication_id") REFERENCES "public"."federation_case_publications"("local_site_id","publication_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_case_attempt_number" ON "federation_case_attempts" USING btree ("submission_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_case_attempt_transaction" ON "federation_case_attempts" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_case_submission_record" ON "federation_case_submissions" USING btree ("local_site_id","publication_id","operation");--> statement-breakpoint
CREATE INDEX "federation_case_submission_pending" ON "federation_case_submissions" USING btree ("local_site_id","state","next_attempt_at");