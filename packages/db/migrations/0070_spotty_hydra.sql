CREATE TABLE "automation_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by" uuid,
	"name" varchar(120) NOT NULL,
	"secret_hash" varchar(64) NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "service_account" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_credentials" ADD CONSTRAINT "automation_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_credentials" ADD CONSTRAINT "automation_credentials_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_credentials" ADD CONSTRAINT "automation_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_credentials_user_idx" ON "automation_credentials" USING btree ("user_id");