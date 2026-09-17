CREATE TABLE "software_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"requested_by" uuid,
	"action" varchar(32) NOT NULL,
	"spec" varchar(500) NOT NULL,
	"status" varchar(32) DEFAULT 'queued' NOT NULL,
	"stdout" text,
	"stderr" text,
	"exit_code" integer,
	"error" text,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "software_operations_action_check" CHECK ("software_operations"."action" IN ('install', 'uninstall', 'load', 'import_preinstalled')),
	CONSTRAINT "software_operations_status_check" CHECK ("software_operations"."status" IN ('queued', 'running', 'succeeded', 'failed', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "software_operations" ADD CONSTRAINT "software_operations_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_operations" ADD CONSTRAINT "software_operations_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "software_operations_agent_status_idx" ON "software_operations" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "software_operations_requested_at_idx" ON "software_operations" USING btree ("requested_at");