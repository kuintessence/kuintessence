CREATE TABLE "data_upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_asset_id" uuid NOT NULL,
	"target_version" varchar(128) NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"location_kind" varchar(32) NOT NULL,
	"object_path" text NOT NULL,
	"storage_key" text NOT NULL,
	"expected_size_bytes" bigint NOT NULL,
	"expected_content_type" varchar(255) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"committed_version_id" uuid,
	"committed_sha256" varchar(128),
	"committed_etag" varchar(255),
	"commit_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"committed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "data_upload_sessions_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "data_upload_sessions_expected_size_check" CHECK ("data_upload_sessions"."expected_size_bytes" > 0),
	CONSTRAINT "data_upload_sessions_location_kind_check" CHECK ("data_upload_sessions"."location_kind" IN ('platform-object', 'user-private-object')),
	CONSTRAINT "data_upload_sessions_status_check" CHECK ("data_upload_sessions"."status" IN ('pending', 'completed', 'expired', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "data_upload_sessions" ADD CONSTRAINT "data_upload_sessions_data_asset_id_data_assets_id_fk" FOREIGN KEY ("data_asset_id") REFERENCES "public"."data_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_upload_sessions" ADD CONSTRAINT "data_upload_sessions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_upload_sessions" ADD CONSTRAINT "data_upload_sessions_committed_version_id_data_asset_versions_id_fk" FOREIGN KEY ("committed_version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_upload_sessions_asset_version_status_idx" ON "data_upload_sessions" USING btree ("data_asset_id","target_version","status");--> statement-breakpoint
CREATE INDEX "data_upload_sessions_owner_status_idx" ON "data_upload_sessions" USING btree ("owner_user_id","status");