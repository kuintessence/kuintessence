CREATE TABLE "agent_control_sessions" (
	"agent_id" varchar(255) PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"relay_origin" text,
	"session_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scheduler_limits" boolean NOT NULL,
	"pinned_spack" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "netdrive_upload_reservations" (
	"storage_key" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"path" text NOT NULL,
	"size" bigint NOT NULL,
	"generated" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"notification_id" uuid NOT NULL,
	"channel" varchar(16) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now(),
	"delivered_at" timestamp,
	CONSTRAINT "notification_deliveries_notification_id_channel_pk" PRIMARY KEY("notification_id","channel")
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email_enabled" boolean DEFAULT false NOT NULL,
	"webhook_url" text,
	"webhook_secret" text
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"event_key" text NOT NULL,
	"kind" varchar(64) NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"read_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "sandbox_pvc_releases" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"last_attempt_at" timestamp,
	"acknowledged_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spack_catalog_sources" (
	"package_id" uuid PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"digest" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terminal_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"state" jsonb NOT NULL,
	"audit_encrypted" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metering_cron_periods" (
	"stage" text PRIMARY KEY NOT NULL,
	"period_start" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "federation_capabilities" DROP CONSTRAINT "federation_capability_kind";--> statement-breakpoint
ALTER TABLE "workflow_execution_journal" DROP CONSTRAINT "workflow_execution_journal_kind";--> statement-breakpoint
DROP INDEX "spack_package_hash_arch_idx";--> statement-breakpoint
DROP INDEX "data_replicas_version_target_site_idx";--> statement-breakpoint
ALTER TABLE "app_templates" ALTER COLUMN "spec" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "spack_package" ALTER COLUMN "manifest_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_received_disclosures" ALTER COLUMN "evidence" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "data_replicas" ADD COLUMN "requested_by" uuid;--> statement-breakpoint
ALTER TABLE "data_replicas" ADD COLUMN "idempotency_key" varchar(255);--> statement-breakpoint
ALTER TABLE "data_replicas" ADD COLUMN "target_cluster_id" varchar(255);--> statement-breakpoint
ALTER TABLE "data_replicas" ADD COLUMN "attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "data_replicas" ADD COLUMN "lease_until" timestamp;--> statement-breakpoint
ALTER TABLE "data_replicas" ADD COLUMN "cleanup_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "scheduler_limits" jsonb;--> statement-breakpoint
ALTER TABLE "netdrive_files" ADD COLUMN "cleanup_after" timestamp;--> statement-breakpoint
ALTER TABLE "oci_upload_session" ADD COLUMN "completed_digest" varchar(71);--> statement-breakpoint
ALTER TABLE "software_operations" ADD COLUMN "recipe_snapshots" jsonb;--> statement-breakpoint
ALTER TABLE "spack_package" ADD COLUMN "repository_name" text;--> statement-breakpoint
ALTER TABLE "ssh_credentials" ADD COLUMN "jump_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_evidence_cases" ADD COLUMN "retention_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_evidence_cases" ADD COLUMN "retain_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "federation_evidence_cases" ADD COLUMN "retention_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_evidence_cases" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "federation_outbound" ADD COLUMN "local_input_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "agent_control_sessions" ADD CONSTRAINT "agent_control_sessions_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "netdrive_upload_reservations" ADD CONSTRAINT "netdrive_upload_reservations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_pvc_releases" ADD CONSTRAINT "sandbox_pvc_releases_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_pvc_releases" ADD CONSTRAINT "sandbox_pvc_releases_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spack_catalog_sources" ADD CONSTRAINT "spack_catalog_sources_package_id_app_templates_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."app_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "netdrive_upload_reservations_owner_path_idx" ON "netdrive_upload_reservations" USING btree ("owner_id","path");--> statement-breakpoint
CREATE INDEX "netdrive_upload_reservations_expiry_idx" ON "netdrive_upload_reservations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "notification_delivery_due_idx" ON "notification_deliveries" USING btree ("next_attempt_at") WHERE "notification_deliveries"."next_attempt_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_event_idx" ON "notifications" USING btree ("user_id","event_key");--> statement-breakpoint
CREATE INDEX "notifications_user_time_idx" ON "notifications" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "sandbox_pvc_releases_pending_agent_idx" ON "sandbox_pvc_releases" USING btree ("agent_id","acknowledged_at","created_at");--> statement-breakpoint
CREATE INDEX "terminal_sessions_user_idx" ON "terminal_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "terminal_sessions_expiry_idx" ON "terminal_sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "data_replicas" ADD CONSTRAINT "data_replicas_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_replicas_requester_key_idx" ON "data_replicas" USING btree ("requested_by","idempotency_key");--> statement-breakpoint
CREATE INDEX "netdrive_files_cleanup_idx" ON "netdrive_files" USING btree ("cleanup_after") WHERE "netdrive_files"."cleanup_after" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "spack_package_repository_hash_idx" ON "spack_package" USING btree ("namespace_kind",coalesce("namespace_owner"::text, ''),"repository_name","hash");--> statement-breakpoint
CREATE UNIQUE INDEX "data_replicas_version_target_site_idx" ON "data_replicas" USING btree ("data_asset_version_id","target_site_id") WHERE "data_replicas"."status" IN ('pending','syncing','available');--> statement-breakpoint
ALTER TABLE "federation_capabilities" ADD CONSTRAINT "federation_capability_kind" CHECK ("federation_capabilities"."capability" IN ('agreement.read', 'agreement.approve', 'billing.approve', 'settlement.approve', 'adjustment.approve', 'payment.approve', 'arbitration.approve', 'arbitration.read', 'arbitration.decide', 'arbitration.execute', 'disclosure.approve', 'disclosure.receive', 'case.publish', 'case.retain', 'dispute.read', 'dispute.open', 'dispute.resolve', 'attestation.recover', 'asset.read', 'asset.map', 'media.import', 'media.export', 'media.logistics', 'dataset.use.approve', 'delegation.read', 'delegation.submit', 'delegation.cancel', 'result.read', 'market.read', 'market.publish', 'market.claim', 'cluster.use', 'cluster.manage'));--> statement-breakpoint
ALTER TABLE "workflow_execution_journal" ADD CONSTRAINT "workflow_execution_journal_kind" CHECK ("workflow_execution_journal"."entry"->>'kind' IN ('definition', 'version', 'node', 'generated-files'));