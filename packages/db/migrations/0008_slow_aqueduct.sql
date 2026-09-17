CREATE TABLE "cluster_file_roots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" varchar(255) NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"agent_id" varchar(255),
	"path" text NOT NULL,
	"visible_org_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cluster_file_roots" ADD CONSTRAINT "cluster_file_roots_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_file_roots" ADD CONSTRAINT "cluster_file_roots_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cluster_file_roots_provider_idx" ON "cluster_file_roots" USING btree ("provider_org_id");--> statement-breakpoint
CREATE INDEX "cluster_file_roots_agent_idx" ON "cluster_file_roots" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "cluster_file_roots_enabled_idx" ON "cluster_file_roots" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_file_roots_provider_agent_path_idx" ON "cluster_file_roots" USING btree ("provider_org_id","agent_id","path");