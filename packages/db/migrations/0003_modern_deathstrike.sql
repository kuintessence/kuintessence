DROP INDEX "metering_usage_raw_job_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "metering_usage_raw_job_id_idx" ON "metering_usage_raw" USING btree ("job_id");