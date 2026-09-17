CREATE TABLE "ssh_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"session_id" varchar(255) NOT NULL,
	"actor_user" varchar(255) NOT NULL,
	"storage_key" varchar(512) NOT NULL,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp NOT NULL,
	"duration_ms" bigint NOT NULL,
	"size_bytes" bigint NOT NULL,
	"reason" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_recordings_agent_session_idx" ON "ssh_recordings" USING btree ("agent_id","session_id");--> statement-breakpoint
CREATE INDEX "ssh_recordings_ended_at_idx" ON "ssh_recordings" USING btree ("ended_at");