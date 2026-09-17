CREATE TABLE "data_scan_requests" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"import_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"agent_id" varchar(255) NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"managed_root_id" uuid NOT NULL,
	"relative_path" text NOT NULL,
	"deadline_at" timestamp NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"attestation_payload" text,
	"attestation_signature" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "data_scan_requests_import_id_unique" UNIQUE("import_id"),
	CONSTRAINT "data_scan_requests_status_check" CHECK ("data_scan_requests"."status" IN ('pending', 'completed', 'failed')),
	CONSTRAINT "data_scan_requests_attempt_check" CHECK ("data_scan_requests"."attempt" >= 0)
);
--> statement-breakpoint
ALTER TABLE "data_scan_requests" ADD CONSTRAINT "data_scan_requests_import_id_data_asset_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."data_asset_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_scan_requests" ADD CONSTRAINT "data_scan_requests_asset_id_data_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."data_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_scan_requests" ADD CONSTRAINT "data_scan_requests_version_id_data_asset_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."data_asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_scan_requests" ADD CONSTRAINT "data_scan_requests_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_scan_requests" ADD CONSTRAINT "data_scan_requests_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_scan_requests" ADD CONSTRAINT "data_scan_requests_managed_root_id_cluster_file_roots_id_fk" FOREIGN KEY ("managed_root_id") REFERENCES "public"."cluster_file_roots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_scan_requests_agent_pending_idx" ON "data_scan_requests" USING btree ("agent_id","status","deadline_at");