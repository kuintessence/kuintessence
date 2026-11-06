CREATE TABLE "federation_attestation_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"transaction_id" varchar(64) NOT NULL,
	"recovery" text NOT NULL,
	"stage" varchar(24) DEFAULT 'proposal' NOT NULL,
	"validation_code" integer,
	"block_number" numeric(20, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_attestation_attempt" CHECK ("federation_attestation_attempts"."number" > 0 AND "federation_attestation_attempts"."transaction_id" ~ '^[a-f0-9]{64}$' AND octet_length("federation_attestation_attempts"."recovery") BETWEEN 1 AND 4194304),
	CONSTRAINT "federation_attestation_result" CHECK (("federation_attestation_attempts"."stage" IN ('proposal','transaction') AND "federation_attestation_attempts"."validation_code" IS NULL AND "federation_attestation_attempts"."block_number" IS NULL) OR ("federation_attestation_attempts"."stage" = 'anchored' AND "federation_attestation_attempts"."validation_code" = 0 AND "federation_attestation_attempts"."block_number" >= 0) OR ("federation_attestation_attempts"."stage" = 'invalid' AND "federation_attestation_attempts"."validation_code" BETWEEN 1 AND 255 AND "federation_attestation_attempts"."block_number" >= 0))
);
--> statement-breakpoint
CREATE TABLE "federation_evidence_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"domain_id" uuid NOT NULL,
	"issuer_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"first_sequence" numeric(20, 0) NOT NULL,
	"manifest" jsonb NOT NULL,
	"issuer_jws" text,
	"digest" varchar(71),
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_batch_state" CHECK ("federation_evidence_batches"."state" IN ('pending','anchored','needs_review')),
	CONSTRAINT "federation_batch_signature" CHECK (("federation_evidence_batches"."issuer_jws" IS NULL AND "federation_evidence_batches"."digest" IS NULL) OR ("federation_evidence_batches"."issuer_jws" IS NOT NULL AND "federation_evidence_batches"."digest" ~ '^sha256:[a-f0-9]{64}$')),
	CONSTRAINT "federation_batch_lease" CHECK (("federation_evidence_batches"."lease_token" IS NULL) = ("federation_evidence_batches"."lease_until" IS NULL)),
	CONSTRAINT "federation_batch_manifest" CHECK ("federation_evidence_batches"."first_sequence" > 0 AND "federation_evidence_batches"."manifest"->>'batchId' = "federation_evidence_batches"."id"::text AND "federation_evidence_batches"."manifest"->>'domainId' = "federation_evidence_batches"."domain_id"::text AND "federation_evidence_batches"."manifest"->>'issuerSiteId' = "federation_evidence_batches"."issuer_site_id"::text AND "federation_evidence_batches"."manifest"->>'agreementRevisionId' = "federation_evidence_batches"."agreement_revision_id"::text AND "federation_evidence_batches"."manifest"->'records'->0->>'sequence' = "federation_evidence_batches"."first_sequence"::text AND jsonb_array_length("federation_evidence_batches"."manifest"->'records') BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "federation_evidence_streams" (
	"domain_id" uuid NOT NULL,
	"issuer_site_id" uuid NOT NULL,
	"next_sequence" numeric(20, 0) DEFAULT '1' NOT NULL,
	CONSTRAINT "federation_evidence_streams_domain_id_issuer_site_id_pk" PRIMARY KEY("domain_id","issuer_site_id"),
	CONSTRAINT "federation_evidence_sequence_positive" CHECK ("federation_evidence_streams"."next_sequence" > 0)
);
--> statement-breakpoint
ALTER TABLE "federation_attestation_outbox" DROP CONSTRAINT "federation_attestation_state";--> statement-breakpoint
ALTER TABLE "federation_attestation_outbox" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "federation_attestation_outbox" ADD COLUMN "sequence" numeric(20, 0);--> statement-breakpoint
ALTER TABLE "federation_attestation_attempts" ADD CONSTRAINT "federation_attestation_attempts_batch_id_federation_evidence_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."federation_evidence_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_evidence_batches" ADD CONSTRAINT "federation_evidence_batches_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_evidence_batches" ADD CONSTRAINT "federation_evidence_batches_agreement_revision_id_federation_agreements_revision_id_fk" FOREIGN KEY ("agreement_revision_id") REFERENCES "public"."federation_agreements"("revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_evidence_batches" ADD CONSTRAINT "federation_evidence_batches_domain_id_issuer_site_id_federation_evidence_streams_domain_id_issuer_site_id_fk" FOREIGN KEY ("domain_id","issuer_site_id") REFERENCES "public"."federation_evidence_streams"("domain_id","issuer_site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_attestation_tx" ON "federation_attestation_attempts" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_attestation_attempt_number" ON "federation_attestation_attempts" USING btree ("batch_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_batch_sequence" ON "federation_evidence_batches" USING btree ("domain_id","issuer_site_id","first_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_batch_unresolved_stream" ON "federation_evidence_batches" USING btree ("domain_id","issuer_site_id") WHERE "federation_evidence_batches"."state" <> 'anchored';--> statement-breakpoint
CREATE INDEX "federation_batch_pending" ON "federation_evidence_batches" USING btree ("issuer_site_id","state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "federation_batch_agreement" ON "federation_evidence_batches" USING btree ("agreement_revision_id","created_at");--> statement-breakpoint
ALTER TABLE "federation_attestation_outbox" ADD CONSTRAINT "federation_attestation_outbox_batch_id_federation_evidence_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."federation_evidence_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_outbox_batch_sequence" ON "federation_attestation_outbox" USING btree ("batch_id","sequence");--> statement-breakpoint
CREATE INDEX "federation_outbox_pending" ON "federation_attestation_outbox" USING btree ("state","created_at");--> statement-breakpoint
ALTER TABLE "federation_attestation_outbox" ADD CONSTRAINT "federation_attestation_state" CHECK (("federation_attestation_outbox"."state" = 'pending' AND "federation_attestation_outbox"."batch_id" IS NULL AND "federation_attestation_outbox"."sequence" IS NULL) OR ("federation_attestation_outbox"."state" IN ('batched','anchored') AND "federation_attestation_outbox"."batch_id" IS NOT NULL AND "federation_attestation_outbox"."sequence" > 0));