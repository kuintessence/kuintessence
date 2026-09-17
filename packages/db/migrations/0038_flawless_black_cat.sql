CREATE TABLE "job_data_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"input_descriptor" varchar(255) NOT NULL,
	"source" varchar(32) NOT NULL,
	"asset_id" uuid,
	"version_id" uuid,
	"manifest_digest" varchar(128),
	"selected_entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delivery_policy" jsonb DEFAULT '{"download":"deny","derive":"deny","redistribution":"deny","crossCenterReplication":"deny","retention":"source-controlled"}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "job_data_bindings_source_check" CHECK ("job_data_bindings"."source" IN ('netdrive', 'data-market')),
	CONSTRAINT "job_data_bindings_data_market_check" CHECK (("job_data_bindings"."source" = 'netdrive' AND "job_data_bindings"."asset_id" IS NULL AND "job_data_bindings"."version_id" IS NULL AND "job_data_bindings"."manifest_digest" IS NULL) OR ("job_data_bindings"."source" = 'data-market' AND "job_data_bindings"."asset_id" IS NOT NULL AND "job_data_bindings"."version_id" IS NOT NULL AND "job_data_bindings"."manifest_digest" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "job_data_bindings" ADD CONSTRAINT "job_data_bindings_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_data_bindings_job_descriptor_version_idx" ON "job_data_bindings" USING btree ("job_id","input_descriptor","version_id");--> statement-breakpoint
CREATE INDEX "job_data_bindings_job_idx" ON "job_data_bindings" USING btree ("job_id");