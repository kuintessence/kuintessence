CREATE TABLE "software_access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"capability" varchar(32) NOT NULL,
	"requester_user_id" varchar(255) NOT NULL,
	"requester_org_id" uuid,
	"subject_kind" varchar(32) NOT NULL,
	"subject_id" varchar(255) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"reason" text,
	"decision_reason" text,
	"decided_by" varchar(255),
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "software_access_requests_capability_check" CHECK ("software_access_requests"."capability" IN ('view', 'use', 'install')),
	CONSTRAINT "software_access_requests_subject_check" CHECK ("software_access_requests"."subject_kind" IN ('user', 'org')),
	CONSTRAINT "software_access_requests_status_check" CHECK ("software_access_requests"."status" IN ('pending', 'approved', 'rejected', 'canceled'))
);
--> statement-breakpoint
ALTER TABLE "software_policy_overlays" DROP CONSTRAINT "software_policy_overlays_scope_check";--> statement-breakpoint
DROP INDEX "software_policy_overlays_scope_provider_agent_idx";--> statement-breakpoint
ALTER TABLE "software_policy_overlays" ADD COLUMN "cluster_id" varchar(255);--> statement-breakpoint
ALTER TABLE "software_access_requests" ADD CONSTRAINT "software_access_requests_asset_id_software_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."software_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_access_requests" ADD CONSTRAINT "software_access_requests_requester_org_id_orgs_id_fk" FOREIGN KEY ("requester_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "software_access_requests_asset_status_idx" ON "software_access_requests" USING btree ("asset_id","status");--> statement-breakpoint
CREATE INDEX "software_access_requests_requester_idx" ON "software_access_requests" USING btree ("requester_user_id","status");--> statement-breakpoint
CREATE INDEX "software_access_requests_subject_idx" ON "software_access_requests" USING btree ("subject_kind","subject_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "software_policy_overlays_scope_provider_agent_idx" ON "software_policy_overlays" USING btree ("scope","provider_org_id","cluster_id","agent_id");--> statement-breakpoint
ALTER TABLE "software_policy_overlays" ADD CONSTRAINT "software_policy_overlays_scope_check" CHECK ("software_policy_overlays"."scope" IN ('provider', 'cluster', 'agent'));