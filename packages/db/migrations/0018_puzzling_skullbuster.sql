CREATE TABLE "agent_registration_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"site_name" varchar(255) NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"revoked_at" timestamp,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_registration_intents_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "agent_registration_intents" ADD CONSTRAINT "agent_registration_intents_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_registration_intents" ADD CONSTRAINT "agent_registration_intents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_registration_intents_agent_idx" ON "agent_registration_intents" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_registration_intents_provider_idx" ON "agent_registration_intents" USING btree ("provider_org_id");--> statement-breakpoint
CREATE INDEX "agent_registration_intents_active_idx" ON "agent_registration_intents" USING btree ("provider_org_id","expires_at","used_at","revoked_at");