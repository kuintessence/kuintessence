CREATE TABLE "file_transfer_audit_config" (
	"singleton_id" varchar(16) PRIMARY KEY DEFAULT 'default' NOT NULL,
	"user_platform_retention_days" integer DEFAULT 365 NOT NULL,
	"platform_cluster_retention_days" integer DEFAULT 180 NOT NULL,
	"download_evidence_mode" varchar(32) DEFAULT 'controlled_gateway' NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" varchar(255),
	CONSTRAINT "file_transfer_audit_config_singleton_check" CHECK ("file_transfer_audit_config"."singleton_id" = 'default'),
	CONSTRAINT "file_transfer_audit_config_user_retention_check" CHECK ("file_transfer_audit_config"."user_platform_retention_days" BETWEEN 1 AND 3650),
	CONSTRAINT "file_transfer_audit_config_cluster_retention_check" CHECK ("file_transfer_audit_config"."platform_cluster_retention_days" BETWEEN 1 AND 3650),
	CONSTRAINT "file_transfer_audit_config_download_mode_check" CHECK ("file_transfer_audit_config"."download_evidence_mode" IN ('controlled_gateway', 'direct_authorization_only')),
	CONSTRAINT "file_transfer_audit_config_policy_version_check" CHECK ("file_transfer_audit_config"."policy_version" >= 1)
);
