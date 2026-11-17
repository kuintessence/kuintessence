CREATE TABLE "agent_update_requests" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"requested_by" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"release" varchar(64) NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"state" varchar(16) DEFAULT 'requested' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_update_requests_kind_check" CHECK ("agent_update_requests"."kind" IN ('notice', 'update')),
	CONSTRAINT "agent_update_requests_state_check" CHECK ("agent_update_requests"."state" IN ('requested', 'waiting', 'applying', 'restarting', 'succeeded', 'failed', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "agent_update_requests" ADD CONSTRAINT "agent_update_requests_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_update_requests" ADD CONSTRAINT "agent_update_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_update_requests_agent_created_idx" ON "agent_update_requests" USING btree ("agent_id","created_at");