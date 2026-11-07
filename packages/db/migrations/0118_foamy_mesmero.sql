CREATE TABLE "federation_received_usage" (
	"local_site_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"report" jsonb NOT NULL,
	"report_jws" text NOT NULL,
	"digest" varchar(71) NOT NULL,
	"correction_evidence" jsonb,
	"page_jws" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_received_usage_local_site_id_report_id_pk" PRIMARY KEY("local_site_id","report_id"),
	CONSTRAINT "federation_received_usage_identity" CHECK (("federation_received_usage"."number" > 0 AND "federation_received_usage"."report"->>'reportId' = "federation_received_usage"."report_id"::text AND "federation_received_usage"."digest" ~ '^sha256:[a-f0-9]{64}$') IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "federation_usage_syncs" (
	"local_site_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"number" integer DEFAULT 0 NOT NULL,
	"last_report_id" uuid,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"provider_state" varchar(24),
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "federation_usage_syncs_local_site_id_operation_id_pk" PRIMARY KEY("local_site_id","operation_id"),
	CONSTRAINT "federation_usage_sync_state" CHECK ("federation_usage_syncs"."state" IN ('pending','needs_review') AND "federation_usage_syncs"."number" >= 0 AND (("federation_usage_syncs"."number" = 0) = ("federation_usage_syncs"."last_report_id" IS NULL)) AND (("federation_usage_syncs"."lease_token" IS NULL) = ("federation_usage_syncs"."lease_until" IS NULL)))
);
--> statement-breakpoint
ALTER TABLE "federation_received_usage" ADD CONSTRAINT "federation_received_usage_sync_fk" FOREIGN KEY ("local_site_id","operation_id") REFERENCES "public"."federation_usage_syncs"("local_site_id","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_usage_syncs" ADD CONSTRAINT "federation_usage_sync_outbound_fk" FOREIGN KEY ("local_site_id","operation_id") REFERENCES "public"."federation_outbound"("local_site_id","operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_received_usage_sequence" ON "federation_received_usage" USING btree ("local_site_id","operation_id","number");--> statement-breakpoint
CREATE INDEX "federation_usage_sync_pending" ON "federation_usage_syncs" USING btree ("local_site_id","state","next_attempt_at");