CREATE TABLE "agent_certs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"fingerprint_sha256" varchar(64) NOT NULL,
	"subject_cn" varchar(255) NOT NULL,
	"cert_pem" text NOT NULL,
	"issued_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"issued_by" uuid,
	CONSTRAINT "agent_certs_fingerprint_sha256_unique" UNIQUE("fingerprint_sha256")
);
--> statement-breakpoint
CREATE TABLE "agent_installed_software" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"version" varchar(100) NOT NULL,
	"compiler" varchar(100),
	"hash" varchar(64) NOT NULL,
	"spec" varchar(500) NOT NULL,
	"reported_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"metric" varchar(64) NOT NULL,
	"value" double precision NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ts" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_software" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"software_name" varchar(255) NOT NULL,
	"software_version" varchar(50) NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"agent_id" varchar(255) PRIMARY KEY NOT NULL,
	"site_name" varchar(255) NOT NULL,
	"scheduler_type" varchar(50) NOT NULL,
	"scheduler_version" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'offline' NOT NULL,
	"last_heartbeat" timestamp,
	"cpu_usage_percent" integer,
	"memory_used_mb" bigint,
	"memory_total_mb" bigint,
	"max_concurrent_jobs" integer DEFAULT 100 NOT NULL,
	"queue_depth" integer DEFAULT 0 NOT NULL,
	"historical_p95_wait_sec" integer DEFAULT 0 NOT NULL,
	"registered_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agents_status_check" CHECK ("agents"."status" IN ('online', 'offline', 'unhealthy'))
);
--> statement-breakpoint
CREATE TABLE "app_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"version" varchar(50) NOT NULL,
	"description" text,
	"spec" varchar(500) NOT NULL,
	"spec_kind" varchar(20) NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_templates_spec_kind_check" CHECK ("app_templates"."spec_kind" IN ('spack', 'oci', 'module'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" varchar(255) NOT NULL,
	"action" varchar(100) NOT NULL,
	"target" varchar(255) NOT NULL,
	"diff" jsonb,
	"org_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_release" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" varchar(32) NOT NULL,
	"resource_kind" varchar(32) NOT NULL,
	"resource_id" uuid NOT NULL,
	"actor" uuid NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_release_action_check" CHECK ("audit_release"."action" IN ('push', 'force-push', 'pull', 'delete')),
	CONSTRAINT "audit_release_resource_kind_check" CHECK ("audit_release"."resource_kind" IN ('oci-tag', 'spack-package', 'oci-repository'))
);
--> statement-breakpoint
CREATE TABLE "desensitize_alias_map" (
	"alias_id" varchar(64) PRIMARY KEY NOT NULL,
	"salt" varchar(128) NOT NULL,
	"original_value" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desensitize_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" varchar(20) NOT NULL,
	"scope_id" varchar(255),
	"field_path" varchar(255) NOT NULL,
	"action" varchar(20) NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "desensitize_config_scope_check" CHECK ("desensitize_config"."scope" IN ('global', 'provider', 'cluster')),
	CONSTRAINT "desensitize_config_action_check" CHECK ("desensitize_config"."action" IN ('passthrough', 'hash', 'alias', 'redact', 'hide'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"command" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"agent_id" varchar(255),
	"scheduler_job_id" varchar(255),
	"cpus" integer NOT NULL,
	"memory_mb" bigint NOT NULL,
	"gpus" integer DEFAULT 0,
	"wall_time_sec" bigint,
	"working_dir" text,
	"env_vars" jsonb,
	"exit_code" integer,
	"error_message" text,
	"submitted_by" uuid,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"app_template_key" varchar(255),
	"org_id" uuid,
	"placement_trace" jsonb,
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" IN ('pending', 'queued', 'running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "netdrive_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"path" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"content_type" varchar(255) DEFAULT 'application/octet-stream' NOT NULL,
	"etag" varchar(255),
	"storage_key" varchar(512) NOT NULL,
	"mtime" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "netdrive_transfer_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid,
	"actor_id" uuid,
	"org_id" uuid,
	"direction" varchar(10) NOT NULL,
	"bytes" bigint NOT NULL,
	"site_id" varchar(255),
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "netdrive_transfer_log_direction_check" CHECK ("netdrive_transfer_log"."direction" IN ('upload', 'download', 'mirror'))
);
--> statement-breakpoint
CREATE TABLE "oci_blob" (
	"digest" varchar(80) PRIMARY KEY NOT NULL,
	"size" bigint NOT NULL,
	"storage_key" varchar(512) NOT NULL,
	"uploaded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oci_manifest" (
	"digest" varchar(80) PRIMARY KEY NOT NULL,
	"media_type" varchar(255) NOT NULL,
	"config_digest" varchar(80),
	"layers" jsonb NOT NULL,
	"size" bigint NOT NULL,
	"body" "bytea" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oci_repository" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace_kind" varchar(16) NOT NULL,
	"namespace_owner" uuid,
	"name" varchar(255) NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oci_repository_namespace_kind_check" CHECK ("oci_repository"."namespace_kind" IN ('public', 'org', 'user'))
);
--> statement-breakpoint
CREATE TABLE "oci_tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"tag" varchar(255) NOT NULL,
	"manifest_digest" varchar(80) NOT NULL,
	"immutable_at" timestamp DEFAULT now() NOT NULL,
	"pushed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "oci_upload_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"uuid_token" varchar(64) NOT NULL,
	"total_uploaded" bigint DEFAULT 0 NOT NULL,
	"storage_key" varchar(512) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oci_upload_session_uuid_token_unique" UNIQUE("uuid_token")
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduling_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" varchar(20) NOT NULL,
	"scope_id" uuid,
	"name" varchar(255) DEFAULT 'default' NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "scheduling_preferences_scope_check" CHECK ("scheduling_preferences"."scope" IN ('global', 'org', 'user'))
);
--> statement-breakpoint
CREATE TABLE "software_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar(255),
	"scope" varchar(20) DEFAULT 'agent' NOT NULL,
	"allow_list" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deny_list" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lock_enabled" boolean DEFAULT false NOT NULL,
	"mirrors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preinstall_list" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" varchar(64) DEFAULT 'v0' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "software_policies_scope_check" CHECK ("software_policies"."scope" IN ('global', 'org', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "spack_package" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace_kind" varchar(16) NOT NULL,
	"namespace_owner" uuid,
	"spec" varchar(500) NOT NULL,
	"hash" varchar(64) NOT NULL,
	"arch" varchar(64) NOT NULL,
	"buildcache_url" text NOT NULL,
	"manifest_url" text NOT NULL,
	"size_bytes" bigint,
	"uploaded_by" uuid,
	"uploaded_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "spack_package_namespace_kind_check" CHECK ("spack_package"."namespace_kind" IN ('public', 'org', 'user'))
);
--> statement-breakpoint
CREATE TABLE "ssh_credentials" (
	"agent_id" varchar(255) PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"username" text NOT NULL,
	"secret_encrypted" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "sso_config" (
	"singleton_id" varchar(16) PRIMARY KEY DEFAULT 'default' NOT NULL,
	"enabled" integer DEFAULT 0 NOT NULL,
	"provider_type" varchar(20) DEFAULT 'oidc' NOT NULL,
	"issuer_url" text DEFAULT '' NOT NULL,
	"client_id" text DEFAULT '' NOT NULL,
	"client_secret_encrypted" text DEFAULT '' NOT NULL,
	"redirect_uri" text DEFAULT '' NOT NULL,
	"group_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auto_create_users" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" varchar(255),
	CONSTRAINT "sso_config_provider_type_check" CHECK ("sso_config"."provider_type" IN ('oidc', 'saml', 'ldap')),
	CONSTRAINT "sso_config_singleton_check" CHECK ("sso_config"."singleton_id" = 'default')
);
--> statement-breakpoint
CREATE TABLE "usage_quotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" varchar(20) NOT NULL,
	"scope_id" uuid NOT NULL,
	"remaining_credit_units" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "usage_quotas_scope_check" CHECK ("usage_quotas"."scope" IN ('user', 'org'))
);
--> statement-breakpoint
CREATE TABLE "usecase_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"version" varchar(50) NOT NULL,
	"description" text,
	"spec" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" varchar(255),
	"email" varchar(255) NOT NULL,
	"display_name" varchar(255),
	"role" varchar(50) DEFAULT 'user' NOT NULL,
	"org_id" uuid,
	"suspended" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"submitted_by" uuid,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"step_jobs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_runs_status_check" CHECK ("workflow_runs"."status" IN ('running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "workflow_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"version" varchar(50) NOT NULL,
	"description" text,
	"yaml_content" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metering_usage_daily" (
	"bucket_start" timestamp with time zone NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"cluster_name" text NOT NULL,
	"cpu_core_seconds" bigint DEFAULT 0 NOT NULL,
	"gpu_seconds" bigint DEFAULT 0 NOT NULL,
	"memory_mb_seconds" bigint DEFAULT 0 NOT NULL,
	"storage_mb_seconds" bigint DEFAULT 0 NOT NULL,
	"network_egress_mb" numeric(20, 4) DEFAULT '0' NOT NULL,
	"job_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "metering_usage_daily_pk" PRIMARY KEY("bucket_start","org_id","user_id","cluster_name")
);
--> statement-breakpoint
CREATE TABLE "metering_usage_hourly" (
	"bucket_start" timestamp with time zone NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"cluster_name" text NOT NULL,
	"cpu_core_seconds" bigint DEFAULT 0 NOT NULL,
	"gpu_seconds" bigint DEFAULT 0 NOT NULL,
	"memory_mb_seconds" bigint DEFAULT 0 NOT NULL,
	"storage_mb_seconds" bigint DEFAULT 0 NOT NULL,
	"network_egress_mb" numeric(20, 4) DEFAULT '0' NOT NULL,
	"job_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "metering_usage_hourly_pk" PRIMARY KEY("bucket_start","org_id","user_id","cluster_name")
);
--> statement-breakpoint
CREATE TABLE "metering_usage_monthly" (
	"bucket_start" timestamp with time zone NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"cluster_name" text NOT NULL,
	"cpu_core_seconds" bigint DEFAULT 0 NOT NULL,
	"gpu_seconds" bigint DEFAULT 0 NOT NULL,
	"memory_mb_seconds" bigint DEFAULT 0 NOT NULL,
	"storage_mb_seconds" bigint DEFAULT 0 NOT NULL,
	"network_egress_mb" numeric(20, 4) DEFAULT '0' NOT NULL,
	"job_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "metering_usage_monthly_pk" PRIMARY KEY("bucket_start","org_id","user_id","cluster_name")
);
--> statement-breakpoint
CREATE TABLE "metering_usage_raw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"cluster_name" text NOT NULL,
	"app_template_key" text,
	"cpu_core_seconds" bigint NOT NULL,
	"gpu_seconds" bigint DEFAULT 0 NOT NULL,
	"memory_mb_seconds" bigint NOT NULL,
	"storage_mb_seconds" bigint DEFAULT 0 NOT NULL,
	"network_egress_mb" numeric(20, 4) DEFAULT '0' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "metering_webhook" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"events" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"last_sent_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metering_webhook_failures_check" CHECK ("metering_webhook"."failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_certs" ADD CONSTRAINT "agent_certs_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_certs" ADD CONSTRAINT "agent_certs_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_installed_software" ADD CONSTRAINT "agent_installed_software_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_metrics" ADD CONSTRAINT "agent_metrics_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_software" ADD CONSTRAINT "agent_software_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_templates" ADD CONSTRAINT "app_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "netdrive_files" ADD CONSTRAINT "netdrive_files_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "netdrive_transfer_log" ADD CONSTRAINT "netdrive_transfer_log_file_id_netdrive_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."netdrive_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "netdrive_transfer_log" ADD CONSTRAINT "netdrive_transfer_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "netdrive_transfer_log" ADD CONSTRAINT "netdrive_transfer_log_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oci_tag" ADD CONSTRAINT "oci_tag_repository_id_oci_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."oci_repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oci_upload_session" ADD CONSTRAINT "oci_upload_session_repository_id_oci_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."oci_repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_policies" ADD CONSTRAINT "software_policies_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usecase_packages" ADD CONSTRAINT "usecase_packages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_certs_agent_idx" ON "agent_certs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_certs_fingerprint_idx" ON "agent_certs" USING btree ("fingerprint_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_installed_software_agent_hash_idx" ON "agent_installed_software" USING btree ("agent_id","hash");--> statement-breakpoint
CREATE INDEX "agent_installed_software_agent_name_idx" ON "agent_installed_software" USING btree ("agent_id","name");--> statement-breakpoint
CREATE INDEX "agent_metrics_agent_metric_ts_idx" ON "agent_metrics" USING btree ("agent_id","metric","ts");--> statement-breakpoint
CREATE INDEX "agent_metrics_ts_idx" ON "agent_metrics" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "agent_software_agent_name_idx" ON "agent_software" USING btree ("agent_id","software_name");--> statement-breakpoint
CREATE INDEX "agents_status_idx" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "app_templates_name_version_idx" ON "app_templates" USING btree ("name","version");--> statement-breakpoint
CREATE INDEX "audit_log_actor_created_idx" ON "audit_log" USING btree ("actor","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_org_created_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_release_resource_idx" ON "audit_release" USING btree ("resource_kind","resource_id");--> statement-breakpoint
CREATE INDEX "audit_release_actor_idx" ON "audit_release" USING btree ("actor","occurred_at");--> statement-breakpoint
CREATE INDEX "desensitize_alias_map_salt_idx" ON "desensitize_alias_map" USING btree ("salt");--> statement-breakpoint
CREATE INDEX "desensitize_config_scope_idx" ON "desensitize_config" USING btree ("scope","scope_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_agent_status_idx" ON "jobs" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "jobs_submitted_by_idx" ON "jobs" USING btree ("submitted_by","submitted_at");--> statement-breakpoint
CREATE INDEX "jobs_org_status_completed_idx" ON "jobs" USING btree ("org_id","status","completed_at");--> statement-breakpoint
CREATE INDEX "jobs_org_app_completed_idx" ON "jobs" USING btree ("org_id","app_template_key","completed_at");--> statement-breakpoint
CREATE INDEX "netdrive_files_owner_path_idx" ON "netdrive_files" USING btree ("owner_id","path");--> statement-breakpoint
CREATE INDEX "netdrive_files_owner_created_idx" ON "netdrive_files" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "netdrive_transfer_log_org_time_idx" ON "netdrive_transfer_log" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "netdrive_transfer_log_actor_time_idx" ON "netdrive_transfer_log" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oci_repository_ns_name_idx" ON "oci_repository" USING btree ("namespace_kind","namespace_owner","name");--> statement-breakpoint
CREATE UNIQUE INDEX "oci_tag_repo_tag_idx" ON "oci_tag" USING btree ("repository_id","tag");--> statement-breakpoint
CREATE INDEX "oci_tag_repo_digest_idx" ON "oci_tag" USING btree ("repository_id","manifest_digest");--> statement-breakpoint
CREATE INDEX "scheduling_preferences_scope_idx" ON "scheduling_preferences" USING btree ("scope","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "software_policies_scope_agent_idx" ON "software_policies" USING btree ("scope","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spack_package_hash_arch_idx" ON "spack_package" USING btree ("hash","arch");--> statement-breakpoint
CREATE INDEX "spack_package_ns_arch_idx" ON "spack_package" USING btree ("namespace_kind","namespace_owner","arch");--> statement-breakpoint
CREATE INDEX "usage_quotas_scope_idx" ON "usage_quotas" USING btree ("scope","scope_id");--> statement-breakpoint
CREATE INDEX "usecase_packages_name_version_idx" ON "usecase_packages" USING btree ("name","version");--> statement-breakpoint
CREATE INDEX "workflow_runs_submitted_by_idx" ON "workflow_runs" USING btree ("submitted_by");--> statement-breakpoint
CREATE INDEX "workflow_templates_name_version_idx" ON "workflow_templates" USING btree ("name","version");--> statement-breakpoint
CREATE INDEX "metering_usage_daily_org_bucket_idx" ON "metering_usage_daily" USING btree ("org_id","bucket_start");--> statement-breakpoint
CREATE INDEX "metering_usage_hourly_org_bucket_idx" ON "metering_usage_hourly" USING btree ("org_id","bucket_start");--> statement-breakpoint
CREATE INDEX "metering_usage_monthly_org_bucket_idx" ON "metering_usage_monthly" USING btree ("org_id","bucket_start");--> statement-breakpoint
CREATE INDEX "metering_usage_raw_job_id_idx" ON "metering_usage_raw" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "metering_usage_raw_org_started_idx" ON "metering_usage_raw" USING btree ("org_id","started_at");--> statement-breakpoint
CREATE INDEX "metering_usage_raw_user_started_idx" ON "metering_usage_raw" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "metering_usage_raw_cluster_started_idx" ON "metering_usage_raw" USING btree ("cluster_name","started_at");--> statement-breakpoint
CREATE INDEX "metering_usage_raw_finished_at_idx" ON "metering_usage_raw" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "metering_webhook_org_idx" ON "metering_webhook" USING btree ("org_id");