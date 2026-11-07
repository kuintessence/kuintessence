CREATE TABLE "federation_terminal_chunks" (
	"local_site_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"offset" integer NOT NULL,
	"bytes" text NOT NULL,
	CONSTRAINT "federation_terminal_chunks_local_site_id_reservation_id_offset_pk" PRIMARY KEY("local_site_id","reservation_id","offset"),
	CONSTRAINT "federation_terminal_chunk_size" CHECK ("federation_terminal_chunks"."offset" BETWEEN 0 AND 16777215 AND "federation_terminal_chunks"."offset" % 65536 = 0 AND octet_length("federation_terminal_chunks"."bytes") BETWEEN 4 AND 87384)
);
--> statement-breakpoint
CREATE TABLE "federation_terminal_syncs" (
	"local_site_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"state" varchar(24) DEFAULT 'pending' NOT NULL,
	"terminal_id" uuid,
	"proposal_digest" varchar(71),
	"total_bytes" integer,
	"next_offset" integer DEFAULT 0 NOT NULL,
	"proposal" jsonb,
	"acknowledgement_jws" text,
	"last_error" varchar(64),
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "federation_terminal_syncs_local_site_id_reservation_id_pk" PRIMARY KEY("local_site_id","reservation_id"),
	CONSTRAINT "federation_terminal_sync_state" CHECK ("federation_terminal_syncs"."state" IN ('pending','ready','complete','needs_review')),
	CONSTRAINT "federation_terminal_sync_lease" CHECK (("federation_terminal_syncs"."lease_token" IS NULL) = ("federation_terminal_syncs"."lease_until" IS NULL)),
	CONSTRAINT "federation_terminal_sync_content" CHECK (((
    ("federation_terminal_syncs"."terminal_id" IS NULL AND "federation_terminal_syncs"."proposal_digest" IS NULL AND "federation_terminal_syncs"."total_bytes" IS NULL AND "federation_terminal_syncs"."next_offset" = 0 AND "federation_terminal_syncs"."proposal" IS NULL)
    OR ("federation_terminal_syncs"."terminal_id" IS NOT NULL AND "federation_terminal_syncs"."proposal_digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_terminal_syncs"."total_bytes" BETWEEN 1 AND 16777216
      AND "federation_terminal_syncs"."next_offset" BETWEEN 1 AND "federation_terminal_syncs"."total_bytes"
      AND (("federation_terminal_syncs"."proposal" IS NULL AND "federation_terminal_syncs"."next_offset" % 65536 = 0) OR
        ("federation_terminal_syncs"."proposal"->'payload'->>'terminalId' = "federation_terminal_syncs"."terminal_id"::text AND "federation_terminal_syncs"."next_offset" = "federation_terminal_syncs"."total_bytes")))
    ) AND ("federation_terminal_syncs"."state" <> 'ready' OR "federation_terminal_syncs"."proposal" IS NOT NULL)
      AND (("federation_terminal_syncs"."state" = 'complete') = ("federation_terminal_syncs"."acknowledgement_jws" IS NOT NULL))) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_terminal_chunks" ADD CONSTRAINT "federation_terminal_chunk_sync_fk" FOREIGN KEY ("local_site_id","reservation_id") REFERENCES "public"."federation_terminal_syncs"("local_site_id","reservation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_terminal_syncs" ADD CONSTRAINT "federation_terminal_sync_approval_fk" FOREIGN KEY ("local_site_id","reservation_id") REFERENCES "public"."federation_commercial_execution_approvals"("local_site_id","record_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_terminal_sync_pending" ON "federation_terminal_syncs" USING btree ("local_site_id","state","next_attempt_at");