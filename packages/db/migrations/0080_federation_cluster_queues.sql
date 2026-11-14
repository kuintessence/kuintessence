CREATE TABLE "federation_cluster_queues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_site_id" uuid NOT NULL,
	"local_org_id" uuid NOT NULL,
	"config" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "federation_permission_presets" (
	"membership_id" uuid PRIMARY KEY NOT NULL,
	"preset" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "federation_queue_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "federation_outputs" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "federation_run_id" uuid;--> statement-breakpoint
ALTER TABLE "federation_cluster_queues" ADD CONSTRAINT "federation_cluster_queues_local_site_id_federation_sites_id_fk" FOREIGN KEY ("local_site_id") REFERENCES "public"."federation_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_cluster_queues" ADD CONSTRAINT "federation_cluster_queues_local_org_id_orgs_id_fk" FOREIGN KEY ("local_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_cluster_queues" ADD CONSTRAINT "federation_cluster_queues_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_cluster_queues" ADD CONSTRAINT "federation_cluster_queues_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_permission_presets" ADD CONSTRAINT "federation_permission_presets_membership_id_user_org_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."user_org_memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_cluster_queues_org" ON "federation_cluster_queues" USING btree ("local_site_id","local_org_id");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_federation_run_id_workflow_runs_id_fk" FOREIGN KEY ("federation_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'payment.approve', 'arbitration.approve', 'arbitration.read', 'arbitration.decide', 'arbitration.execute', 'disclosure.approve', 'disclosure.receive', 'case.publish', 'dispute.read', 'dispute.open', 'dispute.resolve', 'attestation.recover', 'asset.read', 'asset.map', 'media.import', 'media.export', 'media.logistics', 'dataset.use.approve', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim', 'cluster.use', 'cluster.manage'));