CREATE TABLE "workflow_execution_journal" (
	"run_id" uuid NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"key" text NOT NULL,
	"entry" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_execution_journal_run_id_key_hash_pk" PRIMARY KEY("run_id","key_hash"),
	CONSTRAINT "workflow_execution_journal_hash" CHECK ("workflow_execution_journal"."key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workflow_execution_journal_kind" CHECK ("workflow_execution_journal"."entry"->>'kind' IN ('definition', 'version', 'node'))
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_leases" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"token" uuid,
	"expires_at" timestamp with time zone,
	CONSTRAINT "workflow_execution_lease_pair" CHECK (("workflow_execution_leases"."token" IS NULL) = ("workflow_execution_leases"."expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "workflow_execution_journal" ADD CONSTRAINT "workflow_execution_journal_run_id_workflow_execution_leases_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_execution_leases"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_leases" ADD CONSTRAINT "workflow_execution_leases_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;