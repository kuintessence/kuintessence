ALTER TABLE "jobs" ADD COLUMN "provider_org_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_provider_org_id_orgs_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_provider_org_idx" ON "jobs" USING btree ("provider_org_id");