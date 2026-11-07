CREATE TABLE "federation_accounting_collections" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"request_id" uuid,
	"issued_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" varchar(64),
	"observation" jsonb,
	"digest" varchar(71),
	CONSTRAINT "federation_accounting_state" CHECK ("federation_accounting_collections"."state" IN ('pending','collected','needs_review')),
	CONSTRAINT "federation_accounting_observation" CHECK (("federation_accounting_collections"."state" = 'collected') = ("federation_accounting_collections"."observation" IS NOT NULL AND "federation_accounting_collections"."digest" IS NOT NULL)),
	CONSTRAINT "federation_accounting_digest" CHECK ("federation_accounting_collections"."digest" IS NULL OR "federation_accounting_collections"."digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "federation_accounting_collections" ADD CONSTRAINT "federation_accounting_collections_job_id_federation_terminal_evidence_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."federation_terminal_evidence"("job_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_accounting_due" ON "federation_accounting_collections" USING btree ("state","next_attempt_at");