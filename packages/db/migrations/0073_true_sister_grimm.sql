CREATE TABLE "federation_agreements" (
	"revision_id" uuid PRIMARY KEY NOT NULL,
	"source_site_id" uuid NOT NULL,
	"target_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"execution_user_id" uuid NOT NULL,
	"budget_domain_id" uuid NOT NULL,
	"epoch" uuid NOT NULL,
	"terms" jsonb NOT NULL,
	"terms_digest" varchar(71) NOT NULL,
	"source_approval_jws" text NOT NULL,
	"target_approval_jws" text NOT NULL,
	"state" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_agreement_state" CHECK ("federation_agreements"."state" IN ('active', 'suspended', 'revoked')),
	CONSTRAINT "federation_agreement_sites" CHECK ("federation_agreements"."source_site_id" <> "federation_agreements"."target_site_id")
);
--> statement-breakpoint
CREATE TABLE "federation_attestation_outbox" (
	"evidence_id" uuid PRIMARY KEY NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_attestation_state" CHECK ("federation_attestation_outbox"."state" = 'pending')
);
--> statement-breakpoint
CREATE TABLE "federation_budgets" (
	"domain_id" uuid NOT NULL,
	"epoch" uuid NOT NULL,
	"unit" varchar(64) NOT NULL,
	"limit" numeric(38, 0) NOT NULL,
	"available" numeric(38, 0) NOT NULL,
	"reserved" numeric(38, 0) DEFAULT '0' NOT NULL,
	CONSTRAINT "federation_budgets_domain_id_epoch_pk" PRIMARY KEY("domain_id","epoch"),
	CONSTRAINT "federation_budget_conservation" CHECK ("federation_budgets"."limit" >= 0 AND "federation_budgets"."available" >= 0 AND "federation_budgets"."reserved" >= 0
        AND "federation_budgets"."limit" = "federation_budgets"."available" + "federation_budgets"."reserved")
);
--> statement-breakpoint
CREATE TABLE "federation_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reservation_id" uuid NOT NULL,
	"kind" varchar(24) NOT NULL,
	"jws" text NOT NULL,
	"digest" varchar(71) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_evidence_kind" CHECK ("federation_evidence"."kind" IN ('delegation', 'acceptance'))
);
--> statement-breakpoint
CREATE TABLE "federation_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agreement_revision_id" uuid NOT NULL,
	"sender_site_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"request_digest" varchar(71) NOT NULL,
	"request_jws" text NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"receipt" jsonb NOT NULL,
	"receipt_jws" text,
	"state" varchar(24) DEFAULT 'pending_signature' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_reservation_amount" CHECK ("federation_reservations"."amount" >= 0 AND "federation_reservations"."attempt" > 0),
	CONSTRAINT "federation_reservation_signature" CHECK (
      ("federation_reservations"."state" = 'pending_signature' AND "federation_reservations"."receipt_jws" IS NULL)
      OR ("federation_reservations"."state" = 'reserved' AND "federation_reservations"."receipt_jws" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "federation_agreements" ADD CONSTRAINT "federation_agreements_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_agreements" ADD CONSTRAINT "federation_agreements_execution_user_id_users_id_fk" FOREIGN KEY ("execution_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_agreements" ADD CONSTRAINT "federation_agreements_budget_domain_id_epoch_federation_budgets_domain_id_epoch_fk" FOREIGN KEY ("budget_domain_id","epoch") REFERENCES "public"."federation_budgets"("domain_id","epoch") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_attestation_outbox" ADD CONSTRAINT "federation_attestation_outbox_evidence_id_federation_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."federation_evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_evidence" ADD CONSTRAINT "federation_evidence_reservation_id_federation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."federation_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_reservations" ADD CONSTRAINT "federation_reservations_agreement_revision_id_federation_agreements_revision_id_fk" FOREIGN KEY ("agreement_revision_id") REFERENCES "public"."federation_agreements"("revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_agreement_budget_epoch" ON "federation_agreements" USING btree ("budget_domain_id","epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_evidence_reservation_kind" ON "federation_evidence" USING btree ("reservation_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_request_operation" ON "federation_reservations" USING btree ("sender_site_id","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_task_attempt" ON "federation_reservations" USING btree ("agreement_revision_id","task_id","attempt");--> statement-breakpoint
CREATE INDEX "federation_reservation_recovery" ON "federation_reservations" USING btree ("state","created_at");