CREATE TABLE "ssh_live_sessions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"user" text NOT NULL,
	"source_ip" text,
	"opened_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"close_reason" text,
	"closed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_control_sessions" ADD COLUMN "replica_range_fingerprint" text;--> statement-breakpoint
CREATE INDEX "ssh_live_sessions_owner_idx" ON "ssh_live_sessions" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "ssh_live_sessions_expiry_idx" ON "ssh_live_sessions" USING btree ("expires_at");