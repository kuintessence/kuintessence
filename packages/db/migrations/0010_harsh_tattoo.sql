CREATE TABLE "netdrive_replicas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"site_id" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'available' NOT NULL,
	"size" bigint NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"error_message" text,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "netdrive_replicas_status_check" CHECK ("netdrive_replicas"."status" IN ('pending', 'syncing', 'available', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "netdrive_replicas" ADD CONSTRAINT "netdrive_replicas_file_id_netdrive_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."netdrive_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "netdrive_replicas_file_site_unique" ON "netdrive_replicas" USING btree ("file_id","site_id");--> statement-breakpoint
CREATE INDEX "netdrive_replicas_site_status_idx" ON "netdrive_replicas" USING btree ("site_id","status");--> statement-breakpoint
CREATE INDEX "netdrive_replicas_file_idx" ON "netdrive_replicas" USING btree ("file_id");