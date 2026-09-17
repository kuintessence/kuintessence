CREATE TABLE "authz_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation" varchar(32) NOT NULL,
	"resource_type" varchar(128) NOT NULL,
	"resource_id" varchar(512) NOT NULL,
	"relation" varchar(128) NOT NULL,
	"subject_type" varchar(128) NOT NULL,
	"subject_id" varchar(512) NOT NULL,
	"subject_relation" varchar(128),
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	CONSTRAINT "authz_outbox_operation_check" CHECK ("authz_outbox"."operation" IN ('touch_schema', 'create', 'delete')),
	CONSTRAINT "authz_outbox_status_check" CHECK ("authz_outbox"."status" IN ('pending', 'processing', 'succeeded', 'dead'))
);
--> statement-breakpoint
CREATE TABLE "authz_shadow_diffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_email" varchar(255),
	"resource_type" varchar(128) NOT NULL,
	"resource_id" varchar(512) NOT NULL,
	"permission" varchar(128) NOT NULL,
	"local_allowed" boolean NOT NULL,
	"spice_allowed" boolean NOT NULL,
	"spice_error" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_org_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"role" varchar(32) DEFAULT 'member' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_org_memberships_role_check" CHECK ("user_org_memberships"."role" IN ('owner', 'admin', 'operator', 'member', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "authz_shadow_diffs" ADD CONSTRAINT "authz_shadow_diffs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_org_memberships" ADD CONSTRAINT "user_org_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_org_memberships" ADD CONSTRAINT "user_org_memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authz_outbox_status_next_attempt_idx" ON "authz_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "authz_outbox_tuple_idx" ON "authz_outbox" USING btree ("resource_type","resource_id","relation","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "authz_shadow_diffs_resource_permission_idx" ON "authz_shadow_diffs" USING btree ("resource_type","resource_id","permission");--> statement-breakpoint
CREATE INDEX "authz_shadow_diffs_created_at_idx" ON "authz_shadow_diffs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_org_memberships_user_org_idx" ON "user_org_memberships" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "user_org_memberships_org_role_idx" ON "user_org_memberships" USING btree ("org_id","role");