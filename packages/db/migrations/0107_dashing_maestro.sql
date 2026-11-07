CREATE TABLE "workflow_execution_delegations" (
	"run_id" uuid NOT NULL,
	"path_hash" varchar(64) NOT NULL,
	"path" text NOT NULL,
	"node_id" text NOT NULL,
	"local_site_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"intent_digest" varchar(64) NOT NULL,
	"request" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_execution_delegations_run_id_path_hash_pk" PRIMARY KEY("run_id","path_hash"),
	CONSTRAINT "workflow_execution_delegation_hash" CHECK ("workflow_execution_delegations"."path_hash" ~ '^[0-9a-f]{64}$' AND "workflow_execution_delegations"."intent_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workflow_execution_delegation_request" CHECK ("workflow_execution_delegations"."request"->>'operationId' = "workflow_execution_delegations"."operation_id"::text AND "workflow_execution_delegations"."request"->>'senderSiteId' = "workflow_execution_delegations"."local_site_id"::text)
);
--> statement-breakpoint
ALTER TABLE "workflow_execution_delegations" ADD CONSTRAINT "workflow_execution_delegations_run_id_workflow_execution_leases_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_execution_leases"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_execution_delegation_operation" ON "workflow_execution_delegations" USING btree ("local_site_id","operation_id");