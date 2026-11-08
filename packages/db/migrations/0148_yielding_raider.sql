DROP INDEX "federation_completion_active";--> statement-breakpoint
ALTER TABLE "federation_completion_claims" ADD COLUMN "next_check_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "federation_completion_claims" ADD COLUMN "release_blocker" varchar(64);--> statement-breakpoint
CREATE INDEX "federation_completion_active" ON "federation_completion_claims" USING btree ("local_site_id","next_check_at") WHERE "federation_completion_claims"."released_at" IS NULL;