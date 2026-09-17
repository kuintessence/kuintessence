ALTER TABLE "agents" ADD COLUMN "restricted_data_isolation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job_data_bindings" ADD COLUMN "asset_kind" varchar(32);--> statement-breakpoint
ALTER TABLE "job_data_bindings" ADD COLUMN "sensitivity" varchar(32);--> statement-breakpoint
ALTER TABLE "job_data_bindings" ADD COLUMN "egress_policy" varchar(16) DEFAULT 'deny' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "restricted_no_egress" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job_data_bindings" ADD CONSTRAINT "job_data_bindings_asset_kind_check" CHECK ("job_data_bindings"."asset_kind" IS NULL OR "job_data_bindings"."asset_kind" IN ('training-dataset', 'scientific-dataset', 'reference-data', 'model-artifact', 'pseudopotential', 'licensed-material'));--> statement-breakpoint
ALTER TABLE "job_data_bindings" ADD CONSTRAINT "job_data_bindings_sensitivity_check" CHECK ("job_data_bindings"."sensitivity" IS NULL OR "job_data_bindings"."sensitivity" IN ('open', 'internal', 'restricted', 'regulated'));--> statement-breakpoint
ALTER TABLE "job_data_bindings" ADD CONSTRAINT "job_data_bindings_egress_policy_check" CHECK ("job_data_bindings"."egress_policy" IN ('allow', 'deny'));