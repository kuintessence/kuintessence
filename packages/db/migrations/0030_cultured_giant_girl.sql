CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"current_refresh_jti_hash" varchar(64) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"last_used_at" timestamp DEFAULT now() NOT NULL,
	"rotated_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	"revoked_reason" varchar(32),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_revoked_reason_check" CHECK ("auth_sessions"."revoked_reason" IS NULL OR "auth_sessions"."revoked_reason" IN ('logout', 'replay', 'admin'))
);
--> statement-breakpoint
ALTER TABLE "user_capabilities" DROP CONSTRAINT "user_capabilities_capability_check";--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_active_refresh_jti_idx" ON "auth_sessions" USING btree ("current_refresh_jti_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_created_at_idx" ON "auth_sessions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_sessions_family_idx" ON "auth_sessions" USING btree ("family_id");--> statement-breakpoint
ALTER TABLE "user_capabilities" ADD CONSTRAINT "user_capabilities_capability_check" CHECK ("user_capabilities"."capability" IN ('software_provider', 'audit_readonly'));