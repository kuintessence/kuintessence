CREATE TABLE "federation_workflow_bindings" (
	"reservation_id" uuid PRIMARY KEY NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"snapshot_digest" varchar(71) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_workflow_snapshot_digest" CHECK ("federation_workflow_bindings"."snapshot_digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "federation_workflow_bindings" ADD CONSTRAINT "federation_workflow_bindings_reservation_id_federation_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."federation_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_workflow_bindings" ADD CONSTRAINT "federation_workflow_bindings_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_workflow_run" ON "federation_workflow_bindings" USING btree ("workflow_run_id");