ALTER TABLE "jobs" ADD COLUMN "software_requirements" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "usecase_package_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "usecase_package_name" varchar(255);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "usecase_package_version" varchar(50);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "usecase_inputs" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "input_staging" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "expected_outputs" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "file_output_descriptors" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "stdin_text" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_usecase_package_id_usecase_packages_id_fk" FOREIGN KEY ("usecase_package_id") REFERENCES "public"."usecase_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_usecase_package_idx" ON "jobs" USING btree ("usecase_package_id");