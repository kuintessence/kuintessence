ALTER TABLE "federation_execution_terminals" DROP CONSTRAINT "federation_execution_terminal_identity";--> statement-breakpoint
ALTER TABLE "federation_execution_terminals" ADD COLUMN "counterparty_jws" text;--> statement-breakpoint
ALTER TABLE "federation_execution_terminals" ADD COLUMN "source_review" jsonb;--> statement-breakpoint
ALTER TABLE "federation_execution_terminals" ADD CONSTRAINT "federation_execution_terminal_identity" CHECK ((
      "federation_execution_terminals"."digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "federation_execution_terminals"."payload"->>'kind' = 'commercial-terminal'
      AND "federation_execution_terminals"."payload"->>'terminalId' = "federation_execution_terminals"."terminal_id"::text
      AND "federation_execution_terminals"."payload"->>'reservationId' = "federation_execution_terminals"."reservation_id"::text
      AND (("federation_execution_terminals"."payload"->>'targetSiteId' = "federation_execution_terminals"."local_site_id"::text AND "federation_execution_terminals"."source_review" IS NULL)
        OR ("federation_execution_terminals"."payload"->>'sourceSiteId' = "federation_execution_terminals"."local_site_id"::text AND "federation_execution_terminals"."source_review" IS NOT NULL AND "federation_execution_terminals"."counterparty_jws" IS NOT NULL))
      AND "federation_execution_terminals"."evidence"->>'reservationId' = "federation_execution_terminals"."reservation_id"::text
      AND "federation_execution_terminals"."evidence"->>'activationId' = "federation_execution_terminals"."payload"->>'activationId'
      AND "federation_execution_terminals"."evidence"->'workflow'->>'status' = "federation_execution_terminals"."payload"->>'outcome'
    ) IS TRUE);