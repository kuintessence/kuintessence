CREATE TABLE "federation_workflow_input_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"path_hash" varchar(64) NOT NULL,
	"path" text NOT NULL,
	"node_id" varchar(1024) NOT NULL,
	"local_org_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"intent_digest" varchar(71) NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_digest" varchar(71) NOT NULL,
	"bindings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_input_export_path" CHECK ("federation_workflow_input_exports"."path_hash" ~ '^[a-f0-9]{64}$' AND octet_length("federation_workflow_input_exports"."path") BETWEEN 1 AND 16384),
	CONSTRAINT "federation_input_export_digest" CHECK ("federation_workflow_input_exports"."intent_digest" ~ '^sha256:[a-f0-9]{64}$' AND "federation_workflow_input_exports"."manifest_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "federation_input_export_bindings" CHECK (jsonb_typeof("federation_workflow_input_exports"."bindings") = 'array' AND jsonb_array_length("federation_workflow_input_exports"."bindings") <= 256)
);
--> statement-breakpoint
ALTER TABLE "federation_workflow_input_exports" ADD CONSTRAINT "federation_workflow_input_exports_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_workflow_input_exports" ADD CONSTRAINT "federation_workflow_input_exports_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_workflow_input_exports" ADD CONSTRAINT "federation_workflow_input_exports_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_input_export_invocation" ON "federation_workflow_input_exports" USING btree ("run_id","path_hash");