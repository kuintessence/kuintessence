CREATE TABLE "federation_execution_terminals" (
	"local_site_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" varchar(71) NOT NULL,
	"evidence" jsonb NOT NULL,
	"approval_jws" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_execution_terminals_local_site_id_reservation_id_pk" PRIMARY KEY("local_site_id","reservation_id"),
	CONSTRAINT "federation_execution_terminal_identity" CHECK ((
      "federation_execution_terminals"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_execution_terminals"."payload"->>'kind' = 'commercial-terminal'
      AND "federation_execution_terminals"."payload"->>'terminalId' = "federation_execution_terminals"."terminal_id"::text
      AND "federation_execution_terminals"."payload"->>'reservationId' = "federation_execution_terminals"."reservation_id"::text
      AND "federation_execution_terminals"."payload"->>'targetSiteId' = "federation_execution_terminals"."local_site_id"::text
      AND "federation_execution_terminals"."evidence"->>'reservationId' = "federation_execution_terminals"."reservation_id"::text
      AND "federation_execution_terminals"."evidence"->>'activationId' = "federation_execution_terminals"."payload"->>'activationId'
      AND "federation_execution_terminals"."evidence"->'workflow'->>'status' = "federation_execution_terminals"."payload"->>'outcome'
    ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "federation_execution_terminals" ADD CONSTRAINT "federation_execution_terminals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_execution_terminals" ADD CONSTRAINT "federation_execution_terminals_local_site_id_reservation_id_federation_commercial_execution_approvals_local_site_id_record_id_fk" FOREIGN KEY ("local_site_id","reservation_id") REFERENCES "public"."federation_commercial_execution_approvals"("local_site_id","record_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_execution_terminal_id" ON "federation_execution_terminals" USING btree ("local_site_id","terminal_id");